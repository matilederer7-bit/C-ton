import React, { useEffect, useState } from "react";
import { Modal } from "../components.js";
import { t } from "./translate.js";
import { subscribeBeforeLocaleChange, type Locale } from "./locale.js";
import { useLocale } from "./useLocale.js";
import {
  captureDrafts, markPendingSwitch, takePendingSwitch, restoreDrafts,
  pendingChoices, commitChoice, currentSuggester, recordDecision,
  type DraftChoice
} from "./localeDraft.js";

/**
 * Nothing the visitor has written is lost when the language changes.
 *
 * The capture side is registered ONCE, at module load, rather than in an effect:
 * the whole tree is keyed on the locale, so a component-scoped subscription
 * would be torn down and re-created around the very switch it has to observe.
 * This listener runs synchronously inside `setLocale`, while the outgoing
 * screen is still mounted and its inputs still hold their text.
 */
let captureRegistered = false;
function registerCaptureOnce(): void {
  if (captureRegistered) return;
  captureRegistered = true;
  subscribeBeforeLocaleChange((from, to) => {
    captureDrafts(from);
    markPendingSwitch(from, to);
  });
}
registerCaptureOnce();

/**
 * Restoring has to survive a tree that is still rendering: a screen may be
 * waiting on its data, so its fields do not exist in the first frame after the
 * remount. Retry briefly instead of giving up on the first miss.
 */
function useRestoredChoices(locale: Locale) {
  const [choices, setChoices] = useState<DraftChoice[] | null>(null);

  // Put the visitor's text back on EVERY arrival at a screen, not only when the
  // language changed: the first paint, a reload (the draft outlives it in this
  // tab) and — crucially — an in-app route change, which does not touch the
  // locale and so would otherwise never re-run the effect below. Leaving a
  // screen and coming back must not cost the visitor their work. `restoreDrafts`
  // never overwrites a field the visitor has already typed into, so running it
  // more often than strictly needed is safe.
  useEffect(() => {
    let cancelled = false;
    let timers: Array<ReturnType<typeof setTimeout>> = [];
    const settle = () => {
      timers.forEach(clearTimeout);
      timers = [0, 150, 450, 1000].map((ms) => setTimeout(() => {
        if (!cancelled) restoreDrafts(locale);
      }, ms));
    };
    settle();
    window.addEventListener("hashchange", settle);
    return () => {
      cancelled = true;
      window.removeEventListener("hashchange", settle);
      timers.forEach(clearTimeout);
    };
  }, [locale]);

  useEffect(() => {
    const pending = takePendingSwitch();
    if (!pending || pending.to !== locale) return;

    let cancelled = false;
    let attempts = 0;
    const suggest = currentSuggester();

    const tick = () => {
      if (cancelled) return;
      attempts += 1;
      // 1. Put the visitor's own words back FIRST. Even if they never answer
      //    the dialog — or dismiss it — their text is already on screen.
      restoreDrafts(locale);
      // 2. Then ask, but only about real prose that actually has text.
      const found = pendingChoices(pending.from, pending.to, suggest);
      if (found.length) { setChoices(found); return; }
      if (attempts < 8) setTimeout(tick, 150);
      else setChoices([]);
    };
    tick();
    return () => { cancelled = true; };
  }, [locale]);

  return [choices, setChoices] as const;
}

export function LocaleDraftGuard() {
  const [locale] = useLocale();
  const [choices, setChoices] = useRestoredChoices(locale);
  const [edited, setEdited] = useState<Record<string, string>>({});

  if (!choices || choices.length === 0) return null;

  const valueFor = (choice: DraftChoice) =>
    edited[choice.id] !== undefined ? edited[choice.id]! : choice.suggestion;

  const keepOriginal = () => {
    // The fields already hold the original text (restored before the dialog
    // opened), so nothing has to move. The answer is recorded against THIS
    // original so the same content is not queried again on the next switch —
    // while the other language's copy is left untouched.
    for (const choice of choices) recordDecision(choice.id, locale, choice.original, choice.original);
    setChoices([]);
  };

  const useTranslation = () => {
    for (const choice of choices) {
      const next = valueFor(choice);
      if (!next.trim()) continue;
      commitChoice(choice.id, locale, next);
      recordDecision(choice.id, locale, choice.original, next);
    }
    setChoices([]);
  };

  return (
    <Modal
      title={t("locale_draft.title")}
      onClose={keepOriginal}
      wide
      footer={
        <div className="row gap" data-testid="locale-draft-actions">
          <button
            type="button"
            className="btn btn-ghost"
            data-testid="locale-draft-keep-original"
            onClick={keepOriginal}
          >
            {t("locale_draft.keep_original")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="locale-draft-use-translation"
            onClick={useTranslation}
          >
            {t("locale_draft.use_translation")}
          </button>
        </div>
      }
    >
      <div data-testid="locale-draft-prompt">
        <p className="muted small">{t("locale_draft.intro")}</p>
        {choices.map((choice) => (
          <div className="field" key={choice.id} data-testid="locale-draft-item">
            {choice.label ? <strong className="small">{choice.label}</strong> : null}
            <label className="small muted" htmlFor={`locale-draft-original-${choice.id}`}>
              {t("locale_draft.original_label")}
            </label>
            <textarea
              id={`locale-draft-original-${choice.id}`}
              data-testid="locale-draft-original"
              data-locale-draft="off"
              rows={3}
              readOnly
              value={choice.original}
            />
            <label className="small muted" htmlFor={`locale-draft-suggestion-${choice.id}`}>
              {t("locale_draft.suggestion_label")}
            </label>
            <textarea
              id={`locale-draft-suggestion-${choice.id}`}
              data-testid="locale-draft-suggestion"
              data-locale-draft="off"
              rows={3}
              value={valueFor(choice)}
              onChange={(event) => setEdited((prev) => ({ ...prev, [choice.id]: event.target.value }))}
            />
            <p className="small muted" data-testid="locale-draft-note">
              {t("locale_draft.no_engine_note")}
            </p>
          </div>
        ))}
      </div>
    </Modal>
  );
}
