import { Worker } from "@notionhq/workers";
import * as Schema from "@notionhq/workers/schema";
import * as Builder from "@notionhq/workers/builder";
import { XMLParser } from "fast-xml-parser";

/**
 * GDACS -> Notion Worker.
 *
 * A `sync` capability that pulls the GDACS disaster feed and writes significant
 * (Orange/Red) events into a Notion-managed database. Notion hosts and schedules
 * this; deploy it with `ntn workers deploy`.
 *
 * Mode is `incremental` so the database is an accumulating historical log:
 * events are upserted, never deleted. Switch to `replace` if you'd rather keep
 * only a rolling window of currently-active events.
 *
 * Configure via env (set with `ntn workers secrets ...` or wrangler-style vars):
 *   GDACS_FEED   feed filename, default "rss_24h.xml"
 *   MIN_ALERT    "Orange" (Orange+Red) or "Red" (Red only), default "Orange"
 */

const worker = new Worker();
export default worker;

const GDACS_BASE = "https://www.gdacs.org/xml/";
const ALERT_RANK: Record<string, number> = { Green: 1, Orange: 2, Red: 3 };

const EVENT_TYPE_NAMES: Record<string, string> = {
  EQ: "Earthquake",
  TC: "Tropical Cyclone",
  FL: "Flood",
  VO: "Volcano",
  DR: "Drought",
  WF: "Wildfire",
  TS: "Tsunami",
};

// ---------------------------------------------------------------------------
// Managed database. Mirrors the useful fields of an incident-tracking table.
// "GDACS ID" is the primary key, so re-seeing an event updates its row.
// ---------------------------------------------------------------------------
const disasters = worker.database("disasters", {
  type: "managed",
  initialTitle: "Natural Disasters (GDACS Feed)",
  primaryKeyProperty: "GDACS ID",
  schema: {
    properties: {
      Disaster: Schema.title(),
      "GDACS ID": Schema.richText(),
      Type: Schema.select([
        { name: "Earthquake", color: "brown" },
        { name: "Tropical Cyclone", color: "blue" },
        { name: "Flood", color: "blue" },
        { name: "Volcano", color: "red" },
        { name: "Drought", color: "yellow" },
        { name: "Wildfire", color: "orange" },
        { name: "Tsunami", color: "purple" },
      ]),
      "Alert Level": Schema.select([
        { name: "Orange", color: "orange" },
        { name: "Red", color: "red" },
      ]),
      Status: Schema.status({
        groups: [
          { name: "To-do", options: [{ name: "Monitoring", color: "yellow" }] },
          { name: "In progress", options: [{ name: "Active", color: "red" }] },
          { name: "Complete", options: [{ name: "Resolved", color: "green" }] },
        ],
      }),
      Location: Schema.place(),
      "Last Update": Schema.date(),
      "Source URL": Schema.url(),
      Country: Schema.richText(),
      Severity: Schema.richText(),
      "Population Exposed": Schema.number(),
      Summary: Schema.richText(),
    },
  },
});

// ---------------------------------------------------------------------------
// Sync: pull the feed, keep significant events, upsert them.
// ---------------------------------------------------------------------------
const gdacsPacer = worker.pacer("gdacs", { allowedRequests: 5, intervalMs: 1000 });

worker.sync("gdacsSync", {
  database: disasters,
  mode: "incremental",
  schedule: "1d", // min "5m", max "7d"
  execute: async () => {
    await gdacsPacer.wait();

    const feed = process.env.GDACS_FEED || "rss_24h.xml";
    const minRank = ALERT_RANK[process.env.MIN_ALERT || "Orange"] || ALERT_RANK.Orange;

    const events = await fetchGdacsEvents(feed);
    const significant = events.filter((e) => (ALERT_RANK[e.alertLevel] || 0) >= minRank);

    const changes = significant.map((ev) => ({
      type: "upsert" as const,
      key: ev.gdacsId,
      properties: {
        Disaster: Builder.title(ev.title.slice(0, 1900)),
        "GDACS ID": Builder.richText(ev.gdacsId),
        Type: Builder.select(EVENT_TYPE_NAMES[ev.eventType] || ev.eventType || "Other"),
        "Alert Level": Builder.select(ev.alertLevel),
        Status: Builder.status(statusFromAlert(ev.alertLevel)),
        "Source URL": Builder.url(ev.reportUrl),
        "Last Update": ev.lastUpdateIso
          ? Builder.dateTime(ev.lastUpdateIso)
          : Builder.date(today()),
        Country: Builder.richText(ev.country),
        Severity: Builder.richText(ev.severity),
        Summary: Builder.richText(ev.summary),
        // Optional fields: only included when present, via conditional spread.
        ...(Number.isFinite(ev.population)
          ? { "Population Exposed": Builder.number(ev.population) }
          : {}),
        // Builder.place throws without numeric lat/lon, so guard it.
        ...(Number.isFinite(ev.lat) && Number.isFinite(ev.lon)
          ? { Location: Builder.place({ lat: ev.lat, lon: ev.lon, name: ev.country || ev.title }) }
          : {}),
      },
    }));

    // Single-shot: the daily feed is small, so no pagination needed.
    return { changes, hasMore: false };
  },
});

/* ------------------------------- GDACS ------------------------------- */

interface GdacsEvent {
  gdacsId: string;
  eventType: string;
  alertLevel: string;
  country: string;
  severity: string;
  population: number;
  lat: number;
  lon: number;
  reportUrl: string;
  lastUpdateIso: string | null;
  title: string;
  summary: string;
}

async function fetchGdacsEvents(feed: string): Promise<GdacsEvent[]> {
  const res = await fetch(GDACS_BASE + feed, {
    headers: { "User-Agent": "gdacs-notion-worker" },
  });
  if (!res.ok) throw new Error(`GDACS feed ${feed} returned ${res.status}`);
  const xml = await res.text();

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: false,
  });
  const data = parser.parse(xml);

  let items = data?.rss?.channel?.item ?? [];
  if (!Array.isArray(items)) items = [items];

  return items.map(parseItem).filter((e: GdacsEvent | null): e is GdacsEvent => e !== null);
}

function parseItem(item: any): GdacsEvent | null {
  const text = (v: any): string =>
    v == null ? "" : typeof v === "object" ? String(v["#text"] ?? "") : String(v);
  const attrNum = (v: any): number => {
    const raw = v && typeof v === "object" ? v["@_value"] : undefined;
    const n = parseFloat(String(raw ?? ""));
    return Number.isFinite(n) ? n : NaN;
  };

  const eventType = text(item["gdacs:eventtype"]).trim();
  const eventId = text(item["gdacs:eventid"]).trim();
  if (!eventType || !eventId) return null;

  const alertLevel = text(item["gdacs:alertlevel"]).trim() || "Green";
  const country = text(item["gdacs:country"]).trim();
  const toDate = text(item["gdacs:todate"]).trim();
  const pubDate = text(item.pubDate).trim();
  const severity = text(item["gdacs:severity"]).trim();

  const popNode = item["gdacs:population"];
  let population = attrNum(popNode);
  if (!Number.isFinite(population)) {
    const m = text(popNode).replace(/,/g, "").match(/\d+/);
    population = m ? parseInt(m[0], 10) : NaN;
  }

  const point = item["geo:Point"] || {};
  const lat = parseFloat(text(point["geo:lat"]));
  const lon = parseFloat(text(point["geo:long"]));

  const gdacsId = `${eventType}${eventId}`;
  const reportUrl = `https://www.gdacs.org/report.aspx?eventtype=${eventType}&eventid=${eventId}`;
  const lastUpdateIso = toIso(toDate) || toIso(pubDate);

  const title =
    text(item.title).trim() ||
    `${EVENT_TYPE_NAMES[eventType] || eventType} alert – ${country || "Unknown"}`;

  const description = stripHtml(text(item.description));
  const summary = buildSummary({ description, country, severity, lat, lon });

  return {
    gdacsId,
    eventType,
    alertLevel,
    country,
    severity,
    population,
    lat,
    lon,
    reportUrl,
    lastUpdateIso,
    title,
    summary,
  };
}

function buildSummary(o: {
  description: string;
  country: string;
  severity: string;
  lat: number;
  lon: number;
}): string {
  const parts: string[] = [];
  if (o.description) parts.push(o.description);
  const facts: string[] = [];
  if (o.country) facts.push(`Country: ${o.country}`);
  if (o.severity) facts.push(`Severity: ${o.severity}`);
  if (Number.isFinite(o.lat) && Number.isFinite(o.lon)) {
    facts.push(`Coords: ${o.lat}, ${o.lon}`);
  }
  if (facts.length) parts.push(facts.join(" | "));
  return parts.join("\n\n").slice(0, 1900);
}

function statusFromAlert(alertLevel: string): string {
  return alertLevel === "Red" ? "Active" : "Monitoring";
}

/* ------------------------------- helpers ------------------------------- */

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function toIso(dateStr: string): string | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
