// ============================================================================
// zrusit.js — the guest-facing cancellation page.
//
// Spec: docs/superpowers/specs/2026-08-09-reservation-self-cancellation-design.md
//
// Shows a summary and waits for a click rather than cancelling on load. That
// is the whole reason this page exists instead of the SMS linking straight at
// a destructive endpoint: SMS clients, link scanners and chat previews fetch
// URLs unbidden, so a GET that cancelled a booking would let a message preview
// delete someone's table before they ever tapped anything.
//
// Every value written into the DOM here goes through textContent, never
// innerHTML — the table name is owner-controlled rather than guest-controlled,
// but this page renders data fetched from an API for an anonymous audience and
// there is no reason for it to be the one place that interpolates markup.
// ============================================================================

(function () {
    'use strict';

    const API_BASE_URL = window.API_BASE_URL || `http://${window.location.hostname}:3000`;
    // window.APP_BASE_PATH comes from config.js (server.basePath — see
    // brand.js), which loads before this file. Falls back to "/reservation"
    // so a stale cached config.js degrades rather than breaking, matching
    // every other page script.
    const API_URL = `${API_BASE_URL}${window.APP_BASE_PATH || '/reservation'}/api`;

    const token = new URLSearchParams(window.location.search).get('t') || '';

    const statusEl = document.getElementById('cancelStatus');
    const summaryEl = document.getElementById('cancelSummary');
    const confirmBtn = document.getElementById('cancelConfirmBtn');

    function say(text) {
        statusEl.textContent = text;
    }

    function formatDate(dateStr) {
        const parts = String(dateStr || '').split('-');
        if (parts.length !== 3) return dateStr || '';
        return `${Number(parts[2])}.${Number(parts[1])}.${parts[0]}`;
    }

    // hourIndex 1-12 -> 8:00-20:00, the RESERVATION_HOURS convention shared
    // with renderer.js and reservation-cancel.js's START_HOUR_OFFSET. The
    // summary's endHour is the LAST booked hour index, so the booking runs
    // until the end of that hour — hence +8 rather than +7.
    function formatHours(startHour, endHour) {
        return `${startHour + 7}:00 – ${endHour + 8}:00`;
    }

    async function load() {
        if (!token) {
            say('Odkaz je neplatný. Zkontrolujte prosím, že jste ho otevřeli celý.');
            return;
        }

        try {
            const res = await fetch(`${API_URL}/reservations/cancellation?t=${encodeURIComponent(token)}`);
            const body = await res.json().catch(() => ({}));

            if (!res.ok) {
                say(body.error || 'Rezervaci se nepodařilo načíst.');
                return;
            }

            document.getElementById('cancelTable').textContent = body.tableName || '';
            document.getElementById('cancelDate').textContent = formatDate(body.dateStr);
            document.getElementById('cancelTime').textContent = formatHours(body.startHour, body.endHour);
            summaryEl.hidden = false;

            if (body.cancellable) {
                say('Opravdu chcete tuto rezervaci zrušit?');
                confirmBtn.hidden = false;
            } else {
                // The server's own wording, not a locally invented one — it is
                // the authority on why, and the two must never drift apart.
                say(body.reason || 'Tuto rezervaci už nelze zrušit.');
            }
        } catch (e) {
            say('Nepodařilo se spojit se serverem. Zkuste to prosím znovu.');
        }
    }

    async function confirmCancellation() {
        confirmBtn.disabled = true;
        say('Ruším rezervaci…');

        try {
            const res = await fetch(`${API_URL}/reservations/cancel`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token }),
            });
            const body = await res.json().catch(() => ({}));

            if (!res.ok) {
                say(body.error || 'Rezervaci se nepodařilo zrušit.');
                // Re-enabled deliberately: a 409 "already started" is final,
                // but a 500 or a dropped connection is not, and the guest
                // deciding to try again is cheaper than them phoning.
                confirmBtn.disabled = false;
                return;
            }

            summaryEl.hidden = true;
            confirmBtn.hidden = true;
            say('Rezervace byla zrušena. Děkujeme, že jste nám dali vědět.');
        } catch (e) {
            say('Nepodařilo se spojit se serverem. Zkuste to prosím znovu.');
            confirmBtn.disabled = false;
        }
    }

    confirmBtn.addEventListener('click', confirmCancellation);
    load();
})();
