// public/warroom-cancel.js - the "Cancel run" button in the live header (separate from Hush voices).
// A cancel is pending until the server acks it, and the run itself only ends when the CANCELLED meter arrives; if neither
// comes, say so and let the owner retry. Classic script: it uses warroom-app.js's $ and send() when they are called.
/* global $, send */
'use strict';

const CANCEL_RETRY_MS = 8000;
let cancelAt = 0, cancelTimer = 0;
function cancelNote(text) { if ($('cancelnote')) $('cancelnote').textContent = text; }
function cancelSync(active, key) {
  const b = $('nowcancel');
  if (!b) return;
  b.hidden = !active;
  if (!active || key === 'cancelled') { cancelAt = 0; clearTimeout(cancelTimer); b.disabled = false; b.textContent = 'Cancel run'; if (!active) cancelNote(''); }
}
function requestCancel() {
  if (!send({ type: 'cancel' })) { cancelNote('Not connected, so nothing was sent. Reconnect and try again.'); return; }
  cancelAt = Date.now();
  $('nowcancel').disabled = true;
  $('nowcancel').textContent = 'Cancelling...';
  cancelNote('Cancel sent to the War Room.');
  clearTimeout(cancelTimer);
  cancelTimer = setTimeout(() => {
    if (!cancelAt) return;
    $('nowcancel').disabled = false;
    $('nowcancel').textContent = 'Retry cancel';
    cancelNote('No confirmation yet. The run may still be going (and spending). Retry cancel.');
  }, CANCEL_RETRY_MS);
}
