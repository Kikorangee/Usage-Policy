"use strict";

var http = require("http");
var fs = require("fs");
var path = require("path");
var nodemailer = require("nodemailer");

var ROOT = __dirname;
var DATA_DIR = path.join(ROOT, "data");
var CONFIG_PATH = process.env.SERVICE_CONFIG || path.join(ROOT, "service-config.json");
var TEMPLATE_PATH = path.join(ROOT, "email-template.html");
var POLICIES_PATH = path.join(DATA_DIR, "policies.json");
var DELIVERIES_PATH = path.join(DATA_DIR, "deliveries.json");

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}
function envBoolean(name, fallback) {
  if (process.env[name] == null) return fallback;
  return /^(1|true|yes)$/i.test(process.env[name]);
}
function loadConfig() {
  var config = readJson(CONFIG_PATH, {});
  config.server = config.server || {};
  config.smtp = config.smtp || {};
  config.geotab = config.geotab || {};
  config.maptiler = config.maptiler || {};
  config.server.port = Number(process.env.PORT || config.server.port || 8787);
  config.server.pollSeconds = Math.max(30, Number(config.server.pollSeconds || 60));
  config.server.publicBaseUrl = process.env.PUBLIC_BASE_URL || config.server.publicBaseUrl || "";
  config.server.allowedOrigins = config.server.allowedOrigins || [];
  config.smtp.host = process.env.SMTP_HOST || config.smtp.host || "";
  config.smtp.port = Number(process.env.SMTP_PORT || config.smtp.port || 587);
  config.smtp.secure = envBoolean("SMTP_SECURE", Boolean(config.smtp.secure));
  config.smtp.requireTLS = envBoolean("SMTP_REQUIRE_TLS", config.smtp.requireTLS !== false);
  config.smtp.user = process.env.SMTP_USER || config.smtp.user || "";
  config.smtp.password = process.env.SMTP_PASSWORD || config.smtp.password || "";
  config.smtp.fromAddress = process.env.SMTP_FROM_ADDRESS || config.smtp.fromAddress || "";
  config.smtp.fromName = process.env.SMTP_FROM_NAME || config.smtp.fromName || "Geofence Policy Monitor";
  config.smtp.replyTo = process.env.SMTP_REPLY_TO || config.smtp.replyTo || "";
  config.geotab.server = process.env.GEOTAB_SERVER || config.geotab.server || "my.geotab.com";
  config.geotab.database = process.env.GEOTAB_DATABASE || config.geotab.database || "";
  config.geotab.userName = process.env.GEOTAB_USERNAME || config.geotab.userName || "";
  config.geotab.password = process.env.GEOTAB_PASSWORD || config.geotab.password || "";
  config.maptiler.apiKey = process.env.MAPTILER_API_KEY || config.maptiler.apiKey || "";
  config.maptiler.mapId = process.env.MAPTILER_MAP_ID || config.maptiler.mapId || "streets-v4";
  return config;
}
function missingConfig(config) {
  return [
    ["smtp.host", config.smtp.host],
    ["smtp.user", config.smtp.user],
    ["smtp.password", config.smtp.password],
    ["smtp.fromAddress", config.smtp.fromAddress],
    ["geotab.database", config.geotab.database],
    ["geotab.userName", config.geotab.userName],
    ["geotab.password", config.geotab.password]
  ].filter(function (item) { return !String(item[1] || "").trim(); }).map(function (item) { return item[0]; });
}
function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
function replaceTokens(template, values) {
  return template.replace(/\{\{([A-Za-z]+)\}\}/g, function (_, key) {
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : "";
  });
}
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  var temp = file + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temp, file);
}
function geotabHost(value) {
  var host = String(value || "").trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
  if (host !== "my.geotab.com" && !host.endsWith(".geotab.com")) throw new Error("Geotab server hostname is not permitted.");
  return host;
}
async function rpc(server, method, params) {
  var response = await fetch("https://" + geotabHost(server) + "/apiv1", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: method, params: params })
  });
  var body = await response.json().catch(function () { return {}; });
  if (!response.ok || body.error) throw new Error(body.error && body.error.message || "Geotab HTTP " + response.status);
  return body.result;
}
async function validateRegistrationSession(session) {
  if (!session || !session.database || !session.userName || !session.sessionId || !session.server) {
    throw new Error("The MyGeotab registration session is incomplete.");
  }
  await rpc(session.server, "GetSystemTimeUtc", {
    credentials: { database: session.database, userName: session.userName, sessionId: session.sessionId }
  });
}
async function authenticate(config) {
  var result = await rpc(config.geotab.server, "Authenticate", {
    database: config.geotab.database,
    userName: config.geotab.userName,
    password: config.geotab.password
  });
  if (result.path && String(result.path).toLowerCase() !== "thisserver") {
    config.geotab.server = geotabHost(result.path);
  }
  return result.credentials;
}
async function api(config, credentials, method, params) {
  params = params || {};
  params.credentials = credentials;
  return rpc(config.geotab.server, method, params);
}
function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "")); }
function uniqueEmails(values) {
  var seen = {};
  return (values || []).filter(validEmail).filter(function (email) {
    var key = email.toLowerCase();
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}
function validateRegistration(body) {
  if (!body || body.eventType !== "geofencePolicyCreated") throw new Error("Unsupported registration event.");
  if (!body.ruleId || !body.policyName || !body.geotab || !body.geotab.zoneId || !body.geotab.groupId) {
    throw new Error("Policy registration is missing its rule, zone, or group.");
  }
  if (!body.notifications || !body.notifications.enabled) throw new Error("Notifications are not enabled.");
}
function corsOrigin(request, config) {
  var origin = request.headers.origin || "";
  if (!origin) return "";
  try {
    var host = new URL(origin).hostname.toLowerCase();
    if (host === "my.geotab.com" || host.endsWith(".geotab.com") || config.server.allowedOrigins.indexOf(origin) >= 0) return origin;
  } catch (_) {}
  return "";
}
function jsonResponse(response, status, value, origin) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": origin || "null",
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  response.end(JSON.stringify(value));
}
function readBody(request) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    var size = 0;
    request.on("data", function (chunk) {
      size += chunk.length;
      if (size > 1024 * 1024) { reject(new Error("Request body is too large.")); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on("end", function () {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (_) { reject(new Error("Request body is not valid JSON.")); }
    });
    request.on("error", reject);
  });
}
function nearestLog(records, eventDate) {
  return (records || []).filter(function (row) {
    return Number.isFinite(Number(row.latitude)) && Number.isFinite(Number(row.longitude));
  }).sort(function (a, b) {
    return Math.abs(new Date(a.dateTime) - eventDate) - Math.abs(new Date(b.dateTime) - eventDate);
  })[0] || null;
}
function mapUrl(latitude, longitude) {
  return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(latitude + "," + longitude);
}
async function mapImage(config, zone, latitude, longitude) {
  if (!config.maptiler.apiKey) return null;
  var url = new URL("https://api.maptiler.com/maps/" + encodeURIComponent(config.maptiler.mapId) + "/static/auto/800x450.png");
  var points = (zone && zone.points || []).map(function (point) { return Number(point.x) + "," + Number(point.y); });
  if (points.length >= 3) {
    points.push(points[0]);
    url.searchParams.append("path", "stroke:#3157d5|width:4|fill:rgba(49,87,213,0.14)|" + points.join("|"));
  }
  url.searchParams.append("markers", longitude + "," + latitude);
  url.searchParams.set("key", config.maptiler.apiKey);
  var response = await fetch(url);
  if (!response.ok) throw new Error("MapTiler Static Maps returned HTTP " + response.status);
  return Buffer.from(await response.arrayBuffer());
}
async function resolveEvent(config, credentials, policy, event) {
  var eventDate = new Date(event.activeFrom || event.dateTime || Date.now());
  var deviceId = event.device && event.device.id;
  if (!deviceId) throw new Error("Exception event has no device.");
  var fromDate = new Date(eventDate.getTime() - 2 * 60000).toISOString();
  var toDate = new Date(eventDate.getTime() + 5 * 60000).toISOString();
  var results = await Promise.all([
    api(config, credentials, "Get", { typeName: "Device", search: { id: deviceId } }),
    api(config, credentials, "Get", { typeName: "LogRecord", search: { deviceSearch: { id: deviceId }, fromDate: fromDate, toDate: toDate } }),
    api(config, credentials, "Get", { typeName: "Zone", search: { id: policy.geotab.zoneId } })
  ]);
  var device = results[0][0] || { id: deviceId, name: deviceId };
  var record = nearestLog(results[1], eventDate);
  var zone = results[2][0] || { id: policy.geotab.zoneId, name: policy.geotab.zoneName, points: [] };
  var driver = null;
  var driverId = event.driver && event.driver.id;
  if (driverId) {
    var users = await api(config, credentials, "Get", { typeName: "User", search: { id: driverId } });
    driver = users[0] || null;
  }
  var address = "Location unavailable";
  if (record) {
    try {
      var addresses = await api(config, credentials, "GetAddresses", {
        coordinates: [{ x: Number(record.longitude), y: Number(record.latitude) }],
        movingAddresses: true
      });
      address = addresses[0] && addresses[0].formattedAddress || address;
    } catch (error) {
      console.warn("Reverse geocoding failed for event " + event.id + ": " + error.message);
    }
  }
  return { eventDate: eventDate, device: device, driver: driver, record: record, zone: zone, address: address };
}
async function deliver(config, transporter, template, policy, event, details) {
  var recipients = (policy.notifications.backOfficeEmails || []).slice();
  if (policy.notifications.notifyAssignedDriver && details.driver && validEmail(details.driver.name)) recipients.push(details.driver.name);
  recipients = uniqueEmails(recipients);
  if (!recipients.length) return { skipped: "No valid recipient was available." };
  var latitude = details.record && Number(details.record.latitude);
  var longitude = details.record && Number(details.record.longitude);
  var hasLocation = Number.isFinite(latitude) && Number.isFinite(longitude);
  var locationUrl = hasLocation ? mapUrl(latitude, longitude) : "";
  var image = null;
  if (hasLocation && policy.notifications.attachMapImage) {
    try { image = await mapImage(config, details.zone, latitude, longitude); }
    catch (error) { console.warn("Map image omitted for event " + event.id + ": " + error.message); }
  }
  var values = {
    policyName: escapeHtml(policy.policyName),
    vehicleName: escapeHtml(details.device.name || details.device.id),
    driverName: escapeHtml(details.driver && (details.driver.firstName + " " + details.driver.lastName).trim() || "No assigned driver"),
    zoneName: escapeHtml(policy.geotab.zoneName || details.zone.name || details.zone.id),
    ruleLogic: escapeHtml(policy.geotab.trigger || ""),
    eventTime: escapeHtml(details.eventDate.toISOString()),
    address: escapeHtml(details.address),
    coordinates: escapeHtml(hasLocation ? latitude.toFixed(6) + ", " + longitude.toFixed(6) : "Unavailable"),
    mapUrl: escapeHtml(locationUrl),
    mapLink: locationUrl ? '<p style="margin:24px 0 0"><a href="' + escapeHtml(locationUrl) + '" style="display:inline-block;background:#244fd7;color:#fff;text-decoration:none;font-weight:bold;padding:12px 18px;border-radius:6px">Open vehicle location</a></p>' : "",
    mapImage: image ? '<p style="margin:24px 0 0"><img src="cid:geofence-map" width="584" alt="Vehicle and geofence map" style="display:block;max-width:100%;height:auto;border:1px solid #dfe4ec;border-radius:8px"></p>' : ""
  };
  var mail = {
    from: '"' + config.smtp.fromName.replace(/"/g, "") + '" <' + config.smtp.fromAddress + ">",
    to: recipients,
    replyTo: config.smtp.replyTo || undefined,
    subject: "[Geofence Alert] " + policy.policyName + " — " + (details.device.name || details.device.id),
    text: [
      "Geofence policy: " + policy.policyName,
      "Vehicle: " + (details.device.name || details.device.id),
      "Driver: " + (details.driver && details.driver.name || "No assigned driver"),
      "Geofence: " + (policy.geotab.zoneName || details.zone.name || details.zone.id),
      "Event time: " + details.eventDate.toISOString(),
      "Location: " + details.address,
      hasLocation ? "Coordinates: " + latitude + ", " + longitude : "Coordinates: unavailable",
      locationUrl ? "Map: " + locationUrl : ""
    ].filter(Boolean).join("\n"),
    html: replaceTokens(template, values),
    attachments: image ? [{ filename: "geofence-location.png", content: image, cid: "geofence-map" }] : []
  };
  var result = await transporter.sendMail(mail);
  return { messageId: result.messageId, recipients: recipients };
}
async function poll(config, transporter, template, state) {
  if (state.polling) return;
  state.polling = true;
  try {
    var credentials = await authenticate(config);
    var policies = readJson(POLICIES_PATH, []);
    var deliveries = readJson(DELIVERIES_PATH, { processed: {}, cooldowns: {} });
    var now = new Date();
    for (var p = 0; p < policies.length; p += 1) {
      var policy = policies[p];
      var policySucceeded = true;
      var fromDate = policy.lastCheckedAt || policy.registeredAt;
      var events = await api(config, credentials, "Get", {
        typeName: "ExceptionEvent",
        search: {
          deviceSearch: { groups: [{ id: policy.geotab.groupId }] },
          ruleSearch: { id: policy.ruleId },
          fromDate: fromDate,
          toDate: now.toISOString()
        }
      });
      for (var e = 0; e < events.length; e += 1) {
        var event = events[e];
        if (!event.id || deliveries.processed[event.id]) continue;
        var deviceId = event.device && event.device.id || "unknown";
        var cooldownKey = policy.ruleId + ":" + deviceId;
        var cooldownMs = Math.max(0, Number(policy.notifications.cooldownMinutes || 0)) * 60000;
        if (cooldownMs && deliveries.cooldowns[cooldownKey] &&
            now - new Date(deliveries.cooldowns[cooldownKey]) < cooldownMs) {
          deliveries.processed[event.id] = { at: now.toISOString(), skipped: "cooldown" };
          continue;
        }
        try {
          var details = await resolveEvent(config, credentials, policy, event);
          var result = await deliver(config, transporter, template, policy, event, details);
          deliveries.processed[event.id] = { at: now.toISOString(), result: result };
          if (!result.skipped) deliveries.cooldowns[cooldownKey] = now.toISOString();
          console.log("Processed exception event " + event.id + " for policy " + policy.ruleId + ".");
        } catch (error) {
          policySucceeded = false;
          console.error("Event " + event.id + " failed: " + error.message);
        }
      }
      if (policySucceeded) policy.lastCheckedAt = now.toISOString();
    }
    writeJsonAtomic(POLICIES_PATH, policies);
    Object.keys(deliveries.processed).forEach(function (eventId) {
      var processedAt = new Date(deliveries.processed[eventId].at);
      if (now - processedAt > 30 * 24 * 60 * 60 * 1000) delete deliveries.processed[eventId];
    });
    writeJsonAtomic(DELIVERIES_PATH, deliveries);
    state.lastPollAt = now.toISOString();
    state.lastError = "";
  } catch (error) {
    state.lastError = error.message;
    console.error("Polling failed: " + error.message);
  } finally {
    state.polling = false;
  }
}
async function main() {
  var config = loadConfig();
  var missing = missingConfig(config);
  if (missing.length) {
    console.error("Configuration is incomplete. Set: " + missing.join(", "));
    process.exitCode = 1;
    return;
  }
  if (process.argv.indexOf("--check-config") >= 0) {
    console.log("Configuration is valid.");
    return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  var template = fs.readFileSync(TEMPLATE_PATH, "utf8");
  var transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    requireTLS: config.smtp.requireTLS,
    auth: { user: config.smtp.user, pass: config.smtp.password }
  });
  await transporter.verify();
  console.log("SMTP connection verified.");
  var state = { startedAt: new Date().toISOString(), lastPollAt: null, lastError: "", polling: false };
  var server = http.createServer(async function (request, response) {
    var origin = corsOrigin(request, config);
    if (request.headers.origin && !origin) return jsonResponse(response, 403, { ok: false, error: "Origin is not permitted." }, "");
    if (request.method === "OPTIONS") return jsonResponse(response, 204, {}, origin);
    if (request.method === "GET" && request.url === "/health") {
      return jsonResponse(response, 200, {
        ok: !state.lastError,
        build: "2.9.2",
        startedAt: state.startedAt,
        lastPollAt: state.lastPollAt,
        lastError: state.lastError || null,
        registeredPolicies: readJson(POLICIES_PATH, []).length
      }, origin);
    }
    if (request.method === "POST" && request.url === "/api/policies/register") {
      try {
        var body = await readBody(request);
        validateRegistration(body);
        await validateRegistrationSession(body.registrationSession);
        delete body.registrationSession;
        var policies = readJson(POLICIES_PATH, []);
        var existing = policies.findIndex(function (item) { return item.ruleId === body.ruleId; });
        var record = Object.assign({}, body, {
          registeredAt: existing >= 0 ? policies[existing].registeredAt : new Date().toISOString(),
          lastCheckedAt: new Date().toISOString()
        });
        if (existing >= 0) policies[existing] = record; else policies.push(record);
        writeJsonAtomic(POLICIES_PATH, policies);
        console.log("Registered policy " + body.ruleId + " (" + body.policyName + ").");
        return jsonResponse(response, 200, { ok: true, ruleId: body.ruleId, registeredAt: record.registeredAt }, origin);
      } catch (error) {
        return jsonResponse(response, 400, { ok: false, error: error.message }, origin);
      }
    }
    return jsonResponse(response, 404, { ok: false, error: "Route not found." }, origin);
  });
  server.listen(config.server.port, function () {
    console.log("Notification service listening on port " + config.server.port + ".");
  });
  setInterval(function () { poll(config, transporter, template, state); }, config.server.pollSeconds * 1000);
  poll(config, transporter, template, state);
}

main().catch(function (error) {
  console.error("Startup failed: " + error.message);
  process.exitCode = 1;
});
