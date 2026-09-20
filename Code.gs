/**
 * PDF Attachment Dispatcher
 *
 * Google Apps Script web app that fetches remote PDF documents and dispatches
 * them as email attachments. Intended to be called from workflow automation
 * platforms (n8n, Make, Zapier) that can generate a document URL but cannot
 * attach files to an email directly.
 *
 * Security model:
 *   - Requests must carry a shared secret (constant-time compared).
 *   - Source URLs are validated against a host allowlist (anti-SSRF).
 *   - Recipients are validated against a domain allowlist (anti-relay).
 *   - Responses are size-capped and content-type checked.
 *   - An optional outbound callback reports each dispatch to a monitoring
 *     endpoint. The URL is read from Script Properties, never hardcoded.
 *
 * All configuration lives in Script Properties. Nothing is hardcoded.
 * See README.md for setup.
 *
 * Author: Daniel Batista
 * License: MIT
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

var LIMITS = {
  MAX_ATTACHMENTS: 5,
  MAX_BYTES_PER_FILE: 10 * 1024 * 1024,  // 10 MB
  MAX_BYTES_TOTAL: 20 * 1024 * 1024,     // 20 MB
  MAX_SUBJECT_LENGTH: 200,
  MAX_BODY_LENGTH: 20000
};

/**
 * Reads a required Script Property. Fails loudly rather than defaulting,
 * so a misconfigured deployment never runs in an insecure state.
 */
function getRequiredProperty_(key) {
  var value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) {
    throw new Error('Missing required Script Property: ' + key);
  }
  return value;
}

function getListProperty_(key) {
  var raw = PropertiesService.getScriptProperties().getProperty(key) || '';
  return raw.split(',')
            .map(function (s) { return s.trim().toLowerCase(); })
            .filter(function (s) { return s.length > 0; });
}

// ---------------------------------------------------------------------------
// Security helpers
// ---------------------------------------------------------------------------

/**
 * Constant-time string comparison. A naive === leaks length and prefix
 * information through timing, which is enough to brute-force a short token.
 */
function secureCompare_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  var mismatch = 0;
  for (var i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Anti-SSRF. Only https URLs whose host is explicitly allowlisted may be
 * fetched. Without this, any caller could make the script request internal
 * or arbitrary endpoints from Google's infrastructure.
 */
function assertSourceAllowed_(url) {
  if (typeof url !== 'string' || url.indexOf('https://') !== 0) {
    throw new Error('Source URL must use https.');
  }

  var host = url.split('/')[2];
  if (!host) throw new Error('Could not parse host from source URL.');
  host = host.split('@').pop().split(':')[0].toLowerCase();

  var allowed = getListProperty_('ALLOWED_SOURCE_HOSTS');
  if (allowed.length === 0) {
    throw new Error('ALLOWED_SOURCE_HOSTS is not configured.');
  }

  var ok = allowed.some(function (entry) {
    return host === entry || host.slice(-(entry.length + 1)) === '.' + entry;
  });

  if (!ok) throw new Error('Source host not allowlisted: ' + host);
  return url;
}

/**
 * Anti-relay. Without a recipient allowlist, anyone holding the deployment
 * URL can send mail from the owning Google account to arbitrary addresses.
 */
function assertRecipientAllowed_(email) {
  if (typeof email !== 'string' || email.indexOf('@') === -1) {
    throw new Error('Invalid recipient address.');
  }

  var domain = email.split('@').pop().toLowerCase().trim();
  var allowed = getListProperty_('ALLOWED_RECIPIENT_DOMAINS');

  if (allowed.length === 0) {
    throw new Error('ALLOWED_RECIPIENT_DOMAINS is not configured.');
  }
  if (allowed.indexOf(domain) === -1) {
    throw new Error('Recipient domain not allowlisted: ' + domain);
  }
  return email.trim();
}

/**
 * Strips path separators and control characters so a caller-supplied name
 * cannot alter the attachment path or inject header content.
 */
function sanitizeFilename_(name) {
  var cleaned = String(name || 'document')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 100);
  return (cleaned || 'document') + '.pdf';
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Fetches one PDF and returns it as a named blob.
 */
function fetchPdf_(url, filename) {
  assertSourceAllowed_(url);

  var response = UrlFetchApp.fetch(url, {
    method: 'get',
    followRedirects: false,
    muteHttpExceptions: true,
    validateHttpsCertificates: true
  });

  var status = response.getResponseCode();
  if (status !== 200) {
    throw new Error('Source returned HTTP ' + status);
  }

  var contentType = (response.getHeaders()['Content-Type'] || '').toLowerCase();
  if (contentType.indexOf('application/pdf') === -1) {
    throw new Error('Source did not return a PDF (got: ' + contentType + ')');
  }

  var blob = response.getBlob();
  if (blob.getBytes().length > LIMITS.MAX_BYTES_PER_FILE) {
    throw new Error('Attachment exceeds per-file size limit.');
  }

  blob.setName(sanitizeFilename_(filename));
  return blob;
}

/**
 * Builds and sends the message.
 *
 * @param {Object} request
 * @param {string} request.to        Recipient address.
 * @param {string} request.subject   Subject line.
 * @param {string} request.body      Plain-text body.
 * @param {Array}  request.documents [{ url, name }, ...]
 * @return {Object} result summary
 */
function dispatchPdfEmail(request) {
  var recipient = assertRecipientAllowed_(request.to);

  var subject = String(request.subject || '').slice(0, LIMITS.MAX_SUBJECT_LENGTH);
  var body = String(request.body || '').slice(0, LIMITS.MAX_BODY_LENGTH);

  var documents = Array.isArray(request.documents) ? request.documents : [];
  if (documents.length > LIMITS.MAX_ATTACHMENTS) {
    throw new Error('Too many attachments (max ' + LIMITS.MAX_ATTACHMENTS + ').');
  }

  var attachments = [];
  var totalBytes = 0;

  for (var i = 0; i < documents.length; i++) {
    var doc = documents[i];
    if (!doc || !doc.url) continue;

    var blob = fetchPdf_(doc.url, doc.name);
    totalBytes += blob.getBytes().length;

    if (totalBytes > LIMITS.MAX_BYTES_TOTAL) {
      throw new Error('Combined attachments exceed total size limit.');
    }
    attachments.push(blob);
  }

  var options = {};
  if (attachments.length > 0) options.attachments = attachments;

  MailApp.sendEmail(recipient, subject, body, options);

  return {
    status: 'success',
    attachments: attachments.length,
    bytes: totalBytes
  };
}

// ---------------------------------------------------------------------------
// Outbound monitoring callback (optional)
// ---------------------------------------------------------------------------

/**
 * Reports the outcome of a dispatch to an external monitoring endpoint,
 * so failures surface in the calling workflow instead of only in the
 * Apps Script execution log.
 *
 * Configuration:
 *   CALLBACK_WEBHOOK_URL  - optional. If unset, notification is skipped.
 *   CALLBACK_TOKEN        - optional. Sent as a bearer token if present.
 *
 * The URL is never hardcoded. A webhook path is itself a credential: it is
 * unauthenticated by default and anyone holding it can inject events.
 *
 * Failures here are swallowed deliberately. A monitoring callback must never
 * turn a delivered email into a reported error.
 */
function notifyCallback_(outcome, recipient, subject, detail) {
  var webhookUrl = PropertiesService
    .getScriptProperties()
    .getProperty('CALLBACK_WEBHOOK_URL');

  if (!webhookUrl) return;

  try {
    assertSourceAllowed_(webhookUrl);

    var headers = {};
    var token = PropertiesService
      .getScriptProperties()
      .getProperty('CALLBACK_TOKEN');
    if (token) headers.Authorization = 'Bearer ' + token;

    UrlFetchApp.fetch(webhookUrl, {
      method: 'post',
      contentType: 'application/json',
      headers: headers,
      muteHttpExceptions: true,
      payload: JSON.stringify({
        outcome: outcome,                 // 'success' | 'error'
        recipient: recipient || null,
        subject: subject || null,
        detail: detail || null,
        timestamp: new Date().toISOString()
      })
    });
  } catch (error) {
    Logger.log('Callback notification failed: ' + error.toString());
  }
}

// ---------------------------------------------------------------------------
// Web app entry point
// ---------------------------------------------------------------------------

function jsonResponse_(payload, ok) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse_({ status: 'error', message: 'Empty request body.' });
    }

    var payload = JSON.parse(e.postData.contents);

    // Authentication happens before any parsing of user-controlled fields.
    if (!secureCompare_(payload.token || '', getRequiredProperty_('SHARED_SECRET'))) {
      Logger.log('Rejected request: invalid token.');
      return jsonResponse_({ status: 'error', message: 'Unauthorized.' });
    }

    var result = dispatchPdfEmail({
      to: payload.to,
      subject: payload.subject,
      body: payload.body,
      documents: payload.documents
    });

    Logger.log('Dispatched ' + result.attachments + ' attachment(s).');
    notifyCallback_('success', payload.to, payload.subject, null);

    return jsonResponse_(result);

  } catch (error) {
    // The message is logged in full but returned generically, so failures
    // do not disclose configuration details to the caller.
    Logger.log('Dispatch failed: ' + error.toString());
    notifyCallback_('error', null, null, error.toString());

    return jsonResponse_({ status: 'error', message: 'Request could not be processed.' });
  }
}
