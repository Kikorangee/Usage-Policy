const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

function element(id, values) {
  const listeners = {};
  const attributes = {};
  return Object.assign({
    id,
    value: "",
    checked: false,
    hidden: false,
    disabled: false,
    textContent: "",
    innerHTML: "",
    className: "",
    title: "",
    children: [],
    addEventListener(type, handler) {
      (listeners[type] ||= []).push(handler);
    },
    appendChild(child) {
      this.children.push(child);
    },
    setAttribute(name, value) { attributes[name] = String(value); },
    getAttribute(name) { return attributes[name]; },
    async fire(type, target) {
      return Promise.all((listeners[type] || []).map(handler => handler({ target: target || this })));
    }
  }, values || {});
}

function createHarness(options = {}) {
  const ids = [
    "message", "policy-result", "zone-select", "group-select", "policy-trigger",
    "policy-name", "policy-schedule", "policy-start-time", "policy-end-time",
    "policy-time-crosses-midnight", "policy-time-window", "policy-start-time-label",
    "policy-end-time-label", "policy-time-summary", "policy-notifications-enabled",
    "notification-details", "back-office-email-field", "notification-summary",
    "notify-driver", "notify-back-office",
    "back-office-emails", "include-location-link", "attach-map-image",
    "notification-cooldown", "notification-webhook-url", "results-body",
    "vehicle-search", "refresh-button", "monitor-button", "interval-select",
    "create-policy-button", "total-count", "inside-count", "outside-count",
    "missing-count", "last-updated", "connection-text", "connection-dot",
    "fleet-map", "map-status", "created-policies-body",
    "created-policies-status", "refresh-policies-button", "refresh-reference-button",
    "select-all-policies",
    "zone-search-input", "zone-search-results", "zone-search-status",
    "policy-validation-message", "open-native-map"
  ];
  const elements = Object.fromEntries(ids.map(id => [id, element(id)]));
  Object.assign(elements["policy-trigger"], { value: options.trigger || "OutsideArea" });
  Object.assign(elements["policy-name"], { value: options.name || "Test policy" });
  Object.assign(elements["policy-schedule"], { value: options.schedule || "FullTime" });
  Object.assign(elements["policy-start-time"], { value: options.start || "16:00" });
  Object.assign(elements["policy-end-time"], { value: options.end || "09:00" });
  Object.assign(elements["policy-time-crosses-midnight"], { value: String(options.overnight || false) });
  Object.assign(elements["zone-select"], { value: "zone1" });
  Object.assign(elements["group-select"], {
    value: options.groupId === undefined ? "group1" : options.groupId
  });
  Object.assign(elements["interval-select"], { value: "30" });
  Object.assign(elements["notification-cooldown"], { value: "30" });
  Object.assign(elements["back-office-emails"], { value: options.emails || "" });
  Object.assign(elements["notification-webhook-url"], { value: options.webhook || "" });
  Object.assign(elements["notify-driver"], { checked: Boolean(options.notifyDriver) });
  Object.assign(elements["notify-back-office"], { checked: Boolean(options.emails) });
  Object.assign(elements["include-location-link"], { checked: Boolean(options.includeLocation) });
  Object.assign(elements["attach-map-image"], { checked: Boolean(options.attachMap) });

  const ruleRadio = element("rule-radio", { value: options.trigger || "OutsideArea", checked: true });
  const scheduleRadio = element("schedule-radio", { value: options.schedule || "FullTime", checked: true });
  const radios = [ruleRadio, scheduleRadio];
  const document = {
    getElementById(id) { return elements[id]; },
    createElement(tag) { return element(tag); },
    querySelector(selector) {
      if (selector === 'input[name="policy-rule-logic"]:checked') return ruleRadio.checked ? ruleRadio : null;
      if (selector === 'input[name="policy-schedule-mode"]:checked') return scheduleRadio.checked ? scheduleRadio : null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector.indexOf("policy-rule-logic") !== -1 && selector.indexOf("policy-schedule-mode") !== -1) return radios;
      if (selector.indexOf("policy-rule-logic") !== -1) return [ruleRadio];
      if (selector.indexOf("policy-schedule-mode") !== -1) return [scheduleRadio];
      return [];
    }
  };

  const layers = [];
  const leaflet = {
    map() {
      return {
        setView() { return this; },
        fitBounds() {},
        invalidateSize() {}
      };
    },
    tileLayer() { return { on() { return this; }, addTo() { return this; } }; },
    featureGroup() {
      return {
        addTo() { return this; },
        clearLayers() {}
      };
    },
    polygon(points, style) {
      layers.push({ type: "polygon", points, style });
      return { bindTooltip() { return this; }, addTo() { return this; } };
    },
    divIcon(options) {
      return options;
    },
    marker(point, options) {
      layers.push({ type: "marker", point, options });
      return { bindPopup() { return this; }, addTo() { return this; } };
    }
  };

  const zones = [{
    id: "zone1",
    name: "Depot",
    points: [{ x: 174, y: -41 }, { x: 175, y: -41 }, { x: 175, y: -40 }, { x: 174, y: -41 }]
  }];
  const devices = [{ id: "device1", name: "Truck 1", groups: [{ id: "group1" }] }];
  const groups = [{ id: "group1", name: "Operations" }];
  const statuses = [{
    device: { id: "device1" },
    latitude: options.latitude == null ? -40.5 : options.latitude,
    longitude: options.longitude == null ? 174.5 : options.longitude,
    speed: 32,
    dateTime: "2026-07-28T08:00:00Z"
  }];
  const state = {
    rules: (options.rules || []).slice(),
    workTimes: [],
    distributions: [],
    adds: [],
    calls: [],
    fetches: []
  };
  let nextId = 1;
  const api = {
    getSession(resolve) {
      resolve({
        database: "test-database",
        userName: "tester@example.com",
        sessionId: "session-token",
        server: "my.geotab.com"
      });
    },
    call(method, params, resolve, reject) {
      try {
        state.calls.push({ method, params });
        if (method === "Get") {
          const result = {
            DeviceStatusInfo: statuses,
            Rule: state.rules,
            WorkTime: state.workTimes,
            DistributionList: state.distributions
          }[params.typeName] || [];
          resolve(result);
          return;
        }
        if (method === "GetCountOf" && params.typeName === "Zone") {
          resolve(zones.length);
          return;
        }
        if (method === "Add") {
          const id = params.typeName.toLowerCase() + nextId++;
          const saved = Object.assign({ id }, params.entity);
          state.adds.push({ typeName: params.typeName, entity: saved });
          if (params.typeName === "Rule") state.rules.push(saved);
          if (params.typeName === "WorkTime") state.workTimes.push(saved);
          if (params.typeName === "DistributionList") state.distributions.push(saved);
          resolve(id);
          return;
        }
        if (method === "Remove") {
          const id = params.entity.id;
          if (params.typeName === "Rule") state.rules = state.rules.filter(item => item.id !== id);
          if (params.typeName === "WorkTime") state.workTimes = state.workTimes.filter(item => item.id !== id);
          if (params.typeName === "DistributionList") {
            state.distributions = state.distributions.filter(item => item.id !== id);
          }
          resolve(null);
          return;
        }
        throw new Error("Unexpected method " + method);
      } catch (error) { reject(error); }
    },
    multiCall(calls, resolve) {
      state.calls.push({ method: "multiCall", calls });
      resolve(calls.map(call => ({
        Zone: zones,
        Device: devices,
        Group: groups,
        Rule: state.rules,
        WorkTime: state.workTimes,
        DistributionList: state.distributions
      }[call[1].typeName] || [])));
    }
  };

  const windowListeners = {};
  const windowObject = {
    L: leaflet,
    geotab: { addin: {} },
    parent: { location: { hash: "" } },
    location: { hostname: "my.geotab.com" },
    confirm: () => true,
    addEventListener(type, handler) { (windowListeners[type] ||= []).push(handler); },
    dispatchEvent() {}
  };
  const context = {
    window: windowObject,
    geotab: windowObject.geotab,
    document,
    console,
    Promise,
    Map,
    Set,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Math,
    CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init.detail; },
    URL,
    encodeURIComponent,
    setTimeout(handler) { handler(); return 1; },
    setInterval() { return 1; },
    clearInterval() {},
    fetch: async (url, request) => {
      state.fetches.push({ url, request, body: JSON.parse(request.body) });
      return { ok: true, json: async () => ({ ok: true }) };
    }
  };
  vm.runInNewContext(fs.readFileSync(__dirname + "/geofence-monitor.js", "utf8"), context);
  const addin = windowObject.geotab.addin.geofenceMonitor();
  addin.initialize(api, {}, () => {});
  addin.focus(api, {});
  return { elements, state, layers, addin, api, ruleRadio, scheduleRadio, windowObject };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
}

async function createPolicy(options) {
  const harness = createHarness(options);
  await settle();
  await harness.elements["create-policy-button"].fire("click");
  await settle();
  return harness;
}

(async () => {
  {
    const h = await createPolicy({
      notifyDriver: true,
      webhook: "https://alerts.example.com/api/policies/register"
    });
    assert.equal(h.state.fetches.length, 1);
    assert.equal(h.state.fetches[0].url, "https://alerts.example.com/api/policies/register");
    assert.equal(h.state.fetches[0].body.registrationSession.database, "test-database");
    assert.equal(h.state.fetches[0].body.registrationSession.server, "my.geotab.com");
  }
  {
    const h = await createPolicy({ trigger: "OutsideArea" });
    const addedRule = h.state.adds.find(item => item.typeName === "Rule");
    assert(addedRule, h.elements["policy-result"].textContent || "Rule was not added");
    const rule = addedRule.entity;
    assert.equal(rule.condition.conditionType, "OutsideArea");
    assert.equal(rule.condition.zone.id, "zone1");
  }
  {
    const h = await createPolicy({
      trigger: "InsideArea", schedule: "RestrictedWindow",
      start: "16:00", end: "09:00", overnight: true
    });
    const workTime = h.state.adds.find(item => item.typeName === "WorkTime").entity;
    const rule = h.state.adds.find(item => item.typeName === "Rule").entity;
    assert.equal(workTime.details.length, 14);
    assert(workTime.details.some(detail => detail.fromTime === "16:00:00" && detail.toTime === "23:59:59"));
    assert(workTime.details.some(detail => detail.fromTime === "00:00:00" && detail.toTime === "09:00:00"));
    assert.equal(rule.condition.conditionType, "And");
    assert.equal(rule.condition.children[1].conditionType, "RuleWorkHours");
  }
  {
    const h = await createPolicy({
      trigger: "OutsideArea", schedule: "PermittedWindow",
      start: "09:00", end: "17:00"
    });
    const rule = h.state.adds.find(item => item.typeName === "Rule").entity;
    assert.equal(rule.condition.children[1].conditionType, "AfterRuleWorkHours");
  }
  {
    const h = await createPolicy({ trigger: "FullTimeUse" });
    const rule = h.state.adds.find(item => item.typeName === "Rule").entity;
    assert.equal(rule.condition.conditionType, "And");
    assert(rule.condition.children.some(child => child.conditionType === "InsideArea"));
    assert(rule.condition.children.some(child => child.conditionType === "Ignition" && child.value === 1));
  }
  {
    const h = await createPolicy({ emails: "ops@example.com,manager@example.com" });
    const addedList = h.state.adds.find(item => item.typeName === "DistributionList");
    assert(addedList, h.elements["policy-result"].textContent + " Adds: " + JSON.stringify(h.state.adds));
    const list = addedList.entity;
    assert.equal(list.recipients.length, 2);
    assert(list.recipients.every(recipient => recipient.recipientType === "Email"));
  }
  {
    const existing = [
      {
        id: "ruleB", name: "Zulu", comment: "Created by Live Geofence Monitor",
        groups: [{ id: "group1" }],
        condition: { conditionType: "OutsideArea", zone: { id: "zone1" } }
      },
      {
        id: "ruleA", name: "Alpha", comment: "Created by Live Geofence Monitor",
        groups: [{ id: "group1" }],
        condition: { conditionType: "InsideArea", zone: { id: "zone1" } }
      },
      {
        id: "other", name: "Unrelated", comment: "Created elsewhere",
        groups: [{ id: "group1" }],
        condition: { conditionType: "InsideArea", zone: { id: "zone1" } }
      }
    ];
    const h = createHarness({ rules: existing });
    await settle();
    const html = h.elements["created-policies-body"].innerHTML;
    assert(html.indexOf("Alpha") < html.indexOf("Zulu"));
    assert(!html.includes("Unrelated"));
    assert.equal(h.elements["created-policies-status"].textContent,
      "2 of 2 created policies selected for monitoring");
    assert(html.includes("policy-monitor-check"));
    assert(html.includes("policy-delete"));
  }
  {
    const h = createHarness();
    await settle();
    await h.elements["refresh-button"].fire("click");
    await settle();
    assert(h.layers.some(layer => layer.type === "polygon"));
    assert(h.layers.some(layer => layer.type === "marker"));
  }
  {
    const h = createHarness();
    await settle();
    assert.equal(h.elements["create-policy-button"].disabled, false);
    h.scheduleRadio.value = "PermittedWindow";
    await h.scheduleRadio.fire("change");
    assert.equal(h.elements["policy-time-window"].hidden, false);
    assert.equal(h.elements["policy-schedule"].value, "PermittedWindow");
    h.scheduleRadio.value = "RestrictedWindow";
    await h.scheduleRadio.fire("change");
    assert.equal(h.elements["policy-start-time-label"].textContent, "Restricted from");
    assert.equal(h.elements["policy-time-crosses-midnight"].value, "true");
    h.elements["notify-back-office"].checked = true;
    h.elements["back-office-emails"].value = "ops@example.com";
    await h.elements["notify-back-office"].fire("change");
    assert.equal(h.elements["notification-details"].hidden, false);
    assert.equal(h.elements["policy-notifications-enabled"].value, "true");
  }
  {
    const h = createHarness({ trigger: "FullTimeUse", latitude: -30, longitude: 160 });
    await settle();
    await h.elements["refresh-button"].fire("click");
    await settle();
    const marker = h.layers.filter(layer => layer.type === "marker").pop();
    assert(marker);
    assert(marker.options.icon.className.indexOf("compliant") !== -1);
    assert(marker.options.icon.html.indexOf("#15803d") !== -1);
  }
  {
    const policies = [1, 2, 3, 4].map(number => ({
      id: "rule" + number,
      name: "Outside policy " + number,
      comment: "Created by Live Geofence Monitor",
      groups: [{ id: "GroupCompanyId" }],
      condition: { conditionType: "OutsideArea", zone: { id: "zone1" } }
    }));
    const h = createHarness({ rules: policies, latitude: -30, longitude: 160 });
    await settle();
    h.elements["zone-select"].value = "";
    await h.elements["refresh-button"].fire("click");
    await settle();
    const marker = h.layers.filter(layer => layer.type === "marker").pop();
    assert(marker);
    assert(marker.options.icon.className.indexOf("policy-trigger") !== -1);
    assert(h.elements["map-status"].textContent.indexOf("4 selected policies") !== -1);
    h.elements["select-all-policies"].checked = false;
    await h.elements["select-all-policies"].fire("change");
    await settle();
    assert(h.elements["created-policies-status"].textContent.indexOf("0 of 4") !== -1);
  }
  {
    const policy = {
      id: "deleteRule",
      name: "Delete me",
      comment: "Created by Live Geofence Monitor",
      groups: [{ id: "GroupCompanyId" }],
      condition: { conditionType: "OutsideArea", zone: { id: "zone1" } }
    };
    const h = createHarness({ rules: [policy] });
    await settle();
    const deleteButton = element("delete-policy", { className: "policy-delete" });
    deleteButton.setAttribute("data-policy-id", "deleteRule");
    await h.elements["created-policies-body"].fire("click", deleteButton);
    await settle();
    assert(h.state.calls.some(call =>
      call.method === "Remove" && call.params.typeName === "Rule" &&
      call.params.entity.id === "deleteRule"
    ));
    assert(!h.state.rules.some(rule => rule.id === "deleteRule"));
  }
  {
    const h = createHarness();
    await settle();
    const referenceLoads = h.state.calls.filter(call => call.method === "multiCall").length;
    h.addin.focus(h.api, {});
    await settle();
    assert.equal(h.state.calls.filter(call => call.method === "multiCall").length, referenceLoads);
    h.elements["group-select"].value = "group1";
    await h.elements["refresh-button"].fire("click");
    await settle();
    const statusCall = h.state.calls.filter(call =>
      call.method === "Get" && call.params.typeName === "DeviceStatusInfo"
    ).pop();
    assert.deepEqual(statusCall.params.search.deviceSearch.groups, [{ id: "group1" }]);
  }
  {
    const h = createHarness({ groupId: "" });
    await settle();
    assert.equal(h.elements["create-policy-button"].disabled, false);
    await h.elements["create-policy-button"].fire("click");
    await settle();
    const ruleAdd = h.state.calls.filter(call =>
      call.method === "Add" && call.params.typeName === "Rule"
    ).pop();
    assert(ruleAdd);
    assert.deepEqual(ruleAdd.params.entity.groups, [{ id: "GroupCompanyId" }]);
  }
  console.log("PASS: 15 Geotab dashboard logic scenarios");
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
