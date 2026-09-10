/**
 * RISK bot — Apps Script side (design doc ranks 21, 22, 27).
 *
 * Owned by the RISK account. Deploy as a web app: Execute as **me**, access
 * **Anyone**. Because "Anyone" is required for the Worker to reach it, doPost
 * verifies the shared secret BEFORE doing anything else.
 *
 * Script properties (File > Project settings > Script properties):
 *   APPS_SCRIPT_SECRET    - long random string; Worker -> here
 *   INBOUND_SECRET        - long random string; here -> Worker
 *   WORKER_URL            - https://risk-bot.<subdomain>.workers.dev
 *   APPLICATION_SHEET_URL - the application responses, tab picked by its gid
 *   TEMPLATES_SHEET_ID    - spreadsheet holding the email templates
 *   TEMPLATES_SHEET_NAME  - its tab name (default "Templates")
 *   INTERVIEW_CALENDAR_ID - optional; defaults to the RISK account's own calendar
 *
 * The application form is addressed by that URL and wired up by running
 * installApplicationTrigger() once. The audition form rotates twice a year, so it
 * goes through /form register instead, which writes these - don't set them by hand:
 *   forms.audition, forms.audition.history
 */

var MAX_ROWS = 500;
var MAX_HISTORY = 20;

var HANDLERS = {
  application: "onApplicationFormSubmit",
  audition: "onAuditionFormSubmit",
};

var HOOK_PATHS = {
  application: "/hooks/application-submit",
  audition: "/hooks/audition-submit",
};

function props_() {
  return PropertiesService.getScriptProperties();
}

function constantTimeEquals_(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

function fail_(message) {
  throw new Error(message);
}

// ------------------------------------------------------------ form registry

function getFormConfig_(type) {
  var raw = props_().getProperty("forms." + type);
  return raw ? JSON.parse(raw) : null;
}

function getHistory_(type) {
  var raw = props_().getProperty("forms." + type + ".history");
  return raw ? JSON.parse(raw) : [];
}

/** Extracts the form id from any Google Forms URL shape. */
function formIdFromUrl_(url) {
  var m = String(url || "").match(/\/forms\/d\/(?:e\/)?([\w-]+)/);
  return m ? m[1] : null;
}

/**
 * Locates the response tab by asking each sheet which form feeds it, rather than
 * guessing at "Form Responses 1" - a spreadsheet can hold several.
 */
function findResponseSheet_(spreadsheet, formId) {
  var sheets = spreadsheet.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var linked = null;
    try {
      linked = sheets[i].getFormUrl();
    } catch (err) {
      linked = null;
    }
    if (linked && formIdFromUrl_(linked) === formId) return sheets[i];
  }
  return null;
}

/**
 * The application responses, addressed by sheet URL rather than by registering
 * the form.
 *
 * The application form doesn't rotate the way the audition form does, so opening
 * it, proving RISK owns it and tracking its history buys nothing. The tab comes
 * from the gid in the URL, so pasting the link with the responses tab selected is
 * the whole configuration.
 */
function applicationSheet_() {
  var url = props_().getProperty("APPLICATION_SHEET_URL");
  if (!url) {
    fail_(
      "APPLICATION_SHEET_URL script property is not set — paste the response sheet's URL with the responses tab selected"
    );
  }

  var idMatch = url.match(/\/spreadsheets\/d\/([\w-]+)/);
  if (!idMatch) fail_("APPLICATION_SHEET_URL doesn't look like a Google Sheets URL");

  var ss = SpreadsheetApp.openById(idMatch[1]);
  var gidMatch = url.match(/[?#&]gid=(\d+)/);
  if (!gidMatch) return ss.getSheets()[0];

  var gid = Number(gidMatch[1]);
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId() === gid) return sheets[i];
  }
  fail_("no tab with gid " + gid + ' in "' + ss.getName() + '"');
}

function sheetForType_(type) {
  if (type === "application") return applicationSheet_();

  var cfg = getFormConfig_(type);
  if (!cfg) fail_("no " + type + " form registered — run /form register first");
  var ss = SpreadsheetApp.openById(cfg.destinationId);
  var sheet = ss.getSheetByName(cfg.sheetName);
  if (!sheet) {
    fail_(
      "registered " + type + ' tab "' + cfg.sheetName + '" no longer exists — re-register the form'
    );
  }
  return sheet;
}

// ---------------------------------------------------------------- web app

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply_({ ok: false, error: "bad JSON" });
  }

  // Verify before doing anything else.
  if (!constantTimeEquals_(String(body.secret || ""), props_().getProperty("APPS_SCRIPT_SECRET"))) {
    return reply_({ ok: false, error: "unauthorized" });
  }

  var params = body.params || {};
  try {
    switch (body.action) {
      case "readApplications":
        return reply_({ ok: true, data: readRows_("application", params) });
      case "readAuditions":
        return reply_({ ok: true, data: readRows_("audition", params) });
      case "getForms":
        return reply_({ ok: true, data: getForms_() });
      case "inspectForm":
        return reply_({ ok: true, data: inspectForm_(params) });
      case "commitForm":
        return reply_({ ok: true, data: commitForm_(params) });
      case "readTemplates":
        return reply_({ ok: true, data: readTemplates_() });
      case "sendEmail":
        return reply_({ ok: true, data: sendEmail_(params) });
      case "createInterviewEvent":
        return reply_({ ok: true, data: createInterviewEvent_(params) });
      default:
        return reply_({ ok: false, error: "unknown action: " + body.action });
    }
  } catch (err) {
    return reply_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function getForms_() {
  return {
    application: getFormConfig_("application"),
    audition: getFormConfig_("audition"),
  };
}

/**
 * params: { rows?: number[], fromRow?: number, limit?: number }
 * Returns display values so dates and numbers arrive as the text a human sees.
 */
function readRows_(type, params) {
  return readSheet_(sheetForType_(type), params);
}

function readSheet_(sheet, params) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return { headers: [], rows: [] };

  var headers = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  var out = [];

  if (params.rows && params.rows.length) {
    for (var i = 0; i < params.rows.length; i++) {
      var r = Number(params.rows[i]);
      if (!(r >= 2) || r > lastRow) continue;
      out.push({ row: r, values: sheet.getRange(r, 1, 1, lastCol).getDisplayValues()[0] });
    }
    return { headers: headers, rows: out };
  }

  var from = Math.max(2, Number(params.fromRow || 2));
  if (from > lastRow) return { headers: headers, rows: [] };
  var limit = Math.min(Number(params.limit || MAX_ROWS), MAX_ROWS);
  var count = Math.min(limit, lastRow - from + 1);

  var block = sheet.getRange(from, 1, count, lastCol).getDisplayValues();
  for (var j = 0; j < block.length; j++) {
    out.push({ row: from + j, values: block[j] });
  }
  return { headers: headers, rows: out };
}

// ------------------------------------------------------ rank 21: registration

/**
 * Read-only inspection. Writes nothing and installs nothing, so the Worker can
 * verify headers and refuse before anything is committed.
 */
function inspectForm_(params) {
  var url = String(params.url || "");
  var formId = formIdFromUrl_(url);
  if (!formId) fail_("that doesn't look like a Google Forms URL");

  var form;
  try {
    form = FormApp.openByUrl(url);
  } catch (err) {
    fail_(
      "couldn't open the form as the RISK account. It must be created by RISK — " +
        "a trigger can't be installed on a form RISK doesn't own. (" + err + ")"
    );
  }

  // Ownership: the doc's constraint, checked before anything is written.
  var owner = null;
  try {
    owner = DriveApp.getFileById(form.getId()).getOwner();
  } catch (err) {
    owner = null;
  }
  var me = Session.getEffectiveUser().getEmail();
  var ownerEmail = owner ? owner.getEmail() : null;
  if (ownerEmail && me && ownerEmail !== me) {
    fail_(
      "that form is owned by " + ownerEmail + ", not " + me +
        ". Create the new form from the RISK account and re-run."
    );
  }

  var destinationId;
  try {
    destinationId = form.getDestinationId();
  } catch (err) {
    destinationId = null;
  }
  if (!destinationId) fail_("that form has no linked response spreadsheet yet");

  var ss = SpreadsheetApp.openById(destinationId);
  var sheet = findResponseSheet_(ss, form.getId());
  if (!sheet) {
    fail_("couldn't find the response tab for that form in " + ss.getName());
  }

  var lastCol = sheet.getLastColumn();
  var headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0] : [];

  return {
    formId: form.getId(),
    formTitle: form.getTitle(),
    formUrl: form.getPublishedUrl(),
    destinationId: destinationId,
    spreadsheetName: ss.getName(),
    sheetName: sheet.getName(),
    headers: headers,
    responseCount: Math.max(0, sheet.getLastRow() - 1),
  };
}

/**
 * Commits a registration: installs the trigger, records the previous form's id
 * and the dates it was live, then writes the new config.
 */
function commitForm_(params) {
  var type = String(params.type || "");
  var handler = HANDLERS[type];
  if (!handler) fail_("unknown form type: " + type);
  if (type === "application") {
    fail_(
      "the application sheet is configured by the APPLICATION_SHEET_URL script property, not by registering the form — run installApplicationTrigger() once after setting it"
    );
  }
  if (!params.formId || !params.destinationId || !params.sheetName) {
    fail_("commitForm needs formId, destinationId and sheetName");
  }

  var previous = getFormConfig_(type);
  var now = new Date().toISOString();

  installTrigger_(handler, params.destinationId);

  if (previous && previous.formId !== params.formId) {
    var history = getHistory_(type);
    history.unshift({
      formId: previous.formId,
      formUrl: previous.formUrl,
      destinationId: previous.destinationId,
      registeredAt: previous.registeredAt,
      retiredAt: now,
    });
    props_().setProperty(
      "forms." + type + ".history",
      JSON.stringify(history.slice(0, MAX_HISTORY))
    );
  }

  var config = {
    formId: params.formId,
    formTitle: params.formTitle || "",
    formUrl: params.formUrl || "",
    destinationId: params.destinationId,
    sheetName: params.sheetName,
    registeredAt: now,
  };
  if (params.emailColumn) config.emailColumn = params.emailColumn;

  props_().setProperty("forms." + type, JSON.stringify(config));
  return { config: config, previous: previous };
}

function installTrigger_(handler, destinationId) {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === handler) ScriptApp.deleteTrigger(existing[i]);
  }
  var ss = SpreadsheetApp.openById(destinationId);
  ScriptApp.newTrigger(handler).forSpreadsheet(ss).onFormSubmit().create();
}

/**
 * Run once from the Apps Script editor after setting APPLICATION_SHEET_URL.
 *
 * Reports the tab and the C/D/E headers it found so they can be eyeballed here,
 * rather than discovered when the first real application silently reads pronouns
 * as names. The Worker re-checks them at the start of every job regardless.
 */
function installApplicationTrigger() {
  var sheet = applicationSheet_();
  var lastCol = sheet.getLastColumn();
  var headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0] : [];

  installTrigger_(HANDLERS.application, sheet.getParent().getId());

  var summary = {
    spreadsheet: sheet.getParent().getName(),
    tab: sheet.getName(),
    responses: Math.max(0, sheet.getLastRow() - 1),
    C_email: headers[2] || "(empty)",
    D_applicantType: headers[3] || "(empty)",
    E_name: headers[4] || "(empty)",
  };
  console.log("application intake wired up: " + JSON.stringify(summary, null, 2));
  return summary;
}

// ----------------------------------------------------------- form notifiers

/**
 * Sends only the row number - the webhook payload carries no applicant data.
 * A failure here is expected to be invisible; that is what the Worker's daily
 * backstop and reconcile exist for.
 */
function notifyWorker_(path, payload) {
  var url = props_().getProperty("WORKER_URL");
  var secret = props_().getProperty("INBOUND_SECRET");
  if (!url || !secret) {
    console.error("WORKER_URL or INBOUND_SECRET not set");
    return;
  }
  try {
    var res = UrlFetchApp.fetch(url.replace(/\/$/, "") + path, {
      method: "post",
      contentType: "application/json",
      headers: { "X-RISK-Secret": secret },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() >= 300) {
      console.error("notifier HTTP " + res.getResponseCode() + ": " + res.getContentText());
    }
  } catch (err) {
    console.error("notifier threw: " + err);
  }
}

/**
 * Both handlers guard on the tab: two forms can land in one spreadsheet, and a
 * spreadsheet trigger fires for every form feeding it. Compared by sheet id
 * rather than name, so renaming the tab doesn't silently stop intake.
 */
function handleSubmit_(type, e) {
  if (!e || !e.range) {
    console.error(type + " submit fired without a range");
    return;
  }

  var expected = null;
  try {
    expected = sheetForType_(type);
  } catch (err) {
    console.error(type + " submit: " + err);
    return;
  }
  if (e.range.getSheet().getSheetId() !== expected.getSheetId()) return;

  notifyWorker_(HOOK_PATHS[type], { row: e.range.getRow() });
}

function onApplicationFormSubmit(e) {
  handleSubmit_("application", e);
}

function onAuditionFormSubmit(e) {
  handleSubmit_("audition", e);
}

// ------------------------------------------------------------ rank 27: email

/**
 * Templates as sheet rows: template_key | subject | body | notes.
 * Rendering happens in the Worker so a director can eyeball and edit the exact
 * text before it goes anywhere.
 */
function templatesSheet_() {
  var id = props_().getProperty("TEMPLATES_SHEET_ID");
  if (!id) fail_("TEMPLATES_SHEET_ID is not set");
  var name = props_().getProperty("TEMPLATES_SHEET_NAME") || "Templates";
  var sheet = SpreadsheetApp.openById(id).getSheetByName(name);
  if (!sheet) fail_('templates tab "' + name + '" not found');
  return sheet;
}

function readTemplates_() {
  return readSheet_(templatesSheet_(), { fromRow: 2, limit: MAX_ROWS });
}

/**
 * Sends as the RISK account, because the deployment executes as its owner.
 *
 * Consumer Gmail allows 100 recipients/day; the remaining quota comes back with
 * every send so the Worker can warn before it runs out mid-round.
 */
function sendEmail_(params) {
  var to = String(params.to || "").trim();
  var subject = String(params.subject || "").trim();
  var body = String(params.body || "");

  if (!to) fail_("sendEmail needs a recipient");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) fail_('"' + to + '" is not an email address');
  if (!subject) fail_("sendEmail needs a subject");
  if (!body.trim()) fail_("sendEmail needs a body");

  var remaining = MailApp.getRemainingDailyQuota();
  if (remaining < 1) {
    fail_("Gmail's daily send quota is used up; try again tomorrow");
  }

  MailApp.sendEmail({ to: to, subject: subject, body: body, name: "RISK" });

  return { to: to, remainingQuota: MailApp.getRemainingDailyQuota() };
}

// -------------------------------------------------------- rank 24: interviews

/**
 * Creates the interview event and invites the applicant.
 *
 * This runs here, not through the service account: a service account cannot add
 * guests without domain-wide delegation. Times arrive as the local date and time
 * the director typed, and are built in the script's own timezone rather than
 * being converted twice.
 */
function createInterviewEvent_(params) {
  var date = String(params.date || "");
  var time = String(params.time || "");
  var minutes = Number(params.durationMinutes || 30);
  var guest = String(params.guestEmail || "").trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail_("date must be YYYY-MM-DD");
  if (!/^\d{2}:\d{2}$/.test(time)) fail_("time must be HH:MM");
  if (!(minutes > 0 && minutes <= 480)) fail_("duration must be 1-480 minutes");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(guest)) fail_('"' + guest + '" is not an email address');

  var parts = date.split("-");
  var clock = time.split(":");
  var start = new Date(
    Number(parts[0]),
    Number(parts[1]) - 1,
    Number(parts[2]),
    Number(clock[0]),
    Number(clock[1]),
    0
  );
  if (isNaN(start.getTime())) fail_("couldn't build a date from " + date + " " + time);
  var end = new Date(start.getTime() + minutes * 60 * 1000);

  var calendarId = props_().getProperty("INTERVIEW_CALENDAR_ID");
  var calendar = calendarId
    ? CalendarApp.getCalendarById(calendarId)
    : CalendarApp.getDefaultCalendar();
  if (!calendar) fail_("interview calendar not found: " + calendarId);

  var event = calendar.createEvent(String(params.title || "RISK interview"), start, end, {
    guests: guest,
    sendInvites: true,
    description: String(params.description || ""),
  });

  return {
    eventId: event.getId(),
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    timeZone: calendar.getTimeZone(),
  };
}
