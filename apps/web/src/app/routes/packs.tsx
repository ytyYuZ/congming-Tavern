/**
 * `/packs` — import and export a content pack (M1-A4).
 *
 * WHY THIS SCREEN EXISTS
 * The acceptance run could build the example with the CLI and could not get it into the app:
 * `tools/stpack-cli` writes a JSON-file library, and the app reads IndexedDB. Nothing in the
 * interface could produce or consume a `.stpack` at all. This screen is that missing door, and
 * it is deliberately the ONLY one: export, file import and the built-in example all run through
 * the same two functions in `packs/pack-import.ts` / `packs/pack-export.ts`, which in turn call
 * `@smarttavern/importers` and `@smarttavern/packages` — the real format, not a second one.
 *
 * WHY THE REPORT IS A STEP AND NOT A NOTIFICATION
 * An import can create rows, reuse rows that are already there, or remap an id onto a fresh one
 * (`packages/importers/src/identity.ts`). Which of the three happens is not something the user
 * can predict from the file name, so the screen shows the importer's own report — findings,
 * counts, and one line per row — BEFORE the write, and writes only on 「确认导入」. The preview
 * is the real import run against a transaction that is then rolled back (`packs/pack-storage.ts`),
 * so what is shown is exactly what will happen, not a guess about it.
 *
 * WHY THE EXAMPLE IS A BUTTON AND NOT A DOCUMENTED CLI COMMAND
 * `buildExampleContentPack` needs no database, so the app can build the same bundle the CLI
 * builds and feed it through the picker's own path. 「导入示例内容包」 therefore cannot drift
 * from a user's file: if one is previewed correctly, so is the other. The CLI keeps its own
 * audience (scripting, a library on disk); what it cannot do is write this app's IndexedDB.
 *
 * WHY THE DATE IS NOT RENDERED AND THE LOCALE IS NOT READ
 * Nothing here formats a date; the copy is entirely from the catalog, so this route does not
 * subscribe to `locale` — `useTranslation` already re-renders on a language switch.
 */

import type { MessageKey } from '@smarttavern/i18n';
import type { ImportAction, ImportEntityKind, ImportReport } from '@smarttavern/importers';
import { Link, useNavigate } from '@tanstack/react-router';
import { type ChangeEvent, useEffect, useState } from 'react';
import { useTranslation } from '../../i18n/use-translation';
import { exampleSessionDraft, isExamplePack } from '../../packs/example-session';
import { downloadBytes } from '../../packs/pack-download';
import { exportLibraryPack } from '../../packs/pack-export';
import { examplePackBytes, importPack, previewPack } from '../../packs/pack-import';
import { packStorage } from '../../packs/pack-storage';
import type { SessionDraft } from '../../session/roster';
import { useChatStore } from '../../state/chat-store';
import { useContentStore } from '../../state/content-store';

/** What a file picker offers. A `.stpack` is a ZIP, so a file manager's own guess also matches. */
const PACK_ACCEPT = '.stpack,application/zip';

/** One row per kind, so a finding or an entity line never shows a raw identifier to the user. */
const ENTITY_KEY: Readonly<Record<ImportEntityKind, MessageKey>> = {
  world: 'pack.entityWorld',
  worldbook: 'pack.entityWorldbook',
  character: 'pack.entityCharacter',
  promptPreset: 'pack.entityPromptPreset',
  session: 'pack.entitySession',
  message: 'pack.entityMessage',
  checkpoint: 'pack.entityCheckpoint',
  agenda: 'pack.entityAgenda',
  memory: 'pack.entityMemory',
};

const ACTION_KEY: Readonly<Record<ImportAction, MessageKey>> = {
  created: 'pack.actionCreated',
  reused: 'pack.actionReused',
  remapped: 'pack.actionRemapped',
  skipped: 'pack.actionSkipped',
};

/** The bytes a confirmation would commit, and the name to show for them. */
interface PendingPack {
  readonly bytes: Uint8Array;
  readonly fileName: string;
}

/** Why a file could not even be turned into bytes. Distinct from a finding about a package. */
function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * One report, rendered identically for the preview and for the result.
 *
 * WHY IT IS SHARED: the two states differ only in their heading and in whether the confirm
 * buttons are present. Two renderers would let the outcome be described differently from the
 * preview that promised it, which is the one thing this screen must not do.
 */
function ImportReportView({
  report,
  title,
  hint,
}: {
  report: ImportReport;
  title: MessageKey;
  hint: MessageKey;
}) {
  const { t } = useTranslation();
  const pkg = report.package;
  return (
    <>
      <h3 className="section-title">{t(title)}</h3>
      <p className="muted">{t(hint)}</p>
      {pkg === undefined ? null : (
        <p className="muted">
          {t('pack.packageLine', {
            name: pkg.name,
            kind: pkg.kind,
            formatVersion: pkg.formatVersion,
          })}
        </p>
      )}
      <p>
        {t('pack.counts', {
          created: report.counts.created,
          reused: report.counts.reused,
          remapped: report.counts.remapped,
          skipped: report.counts.skipped,
        })}
      </p>
      {report.ok ? null : <p className="error">{t('pack.refused')}</p>}

      <h4 className="section-title">{t('pack.findings')}</h4>
      {report.findings.length === 0 ? (
        <p className="muted">{t('pack.noFindings')}</p>
      ) : (
        <ul className="session-list">
          {report.findings.map((finding, index) => (
            // A finding has no id of its own and the list is rebuilt on every import, so the
            // index is the only stable key available; the list is never reordered in place.
            // biome-ignore lint/suspicious/noArrayIndexKey: findings carry no identity.
            <li key={`${finding.code}-${index}`}>
              <strong>{finding.severity}</strong> {finding.detail}
            </li>
          ))}
        </ul>
      )}

      <h4 className="section-title">{t('pack.importedTitle')}</h4>
      {report.entities.length === 0 ? (
        <p className="muted">{t('pack.noFindings')}</p>
      ) : (
        <ul className="session-list">
          {report.entities.map((entity, index) => (
            // Same reasoning as the findings: an entity row is a report line, not a row in a
            // mutable list, and the importer offers no key for it.
            // biome-ignore lint/suspicious/noArrayIndexKey: report lines carry no identity.
            <li key={`${entity.entity}-${index}`}>
              {t(ENTITY_KEY[entity.entity])} · {t(ACTION_KEY[entity.action])} ·{' '}
              {entity.name ?? entity.id ?? entity.packageId}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function PacksRoute() {
  const { t } = useTranslation();
  const worlds = useContentStore((state) => state.worlds);
  const characters = useContentStore((state) => state.characters);
  const loadWorlds = useContentStore((state) => state.loadWorlds);
  const loadCharacters = useContentStore((state) => state.loadCharacters);
  const navigate = useNavigate();

  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<PendingPack | undefined>(undefined);
  const [report, setReport] = useState<ImportReport | undefined>(undefined);
  const [phase, setPhase] = useState<'idle' | 'preview' | 'done'>('idle');
  const [busy, setBusy] = useState(false);
  const [startDraft, setStartDraft] = useState<SessionDraft | undefined>(undefined);
  const [started, setStarted] = useState<string | undefined>(undefined);
  const [startFailure, setStartFailure] = useState<string | undefined>(undefined);

  useEffect(() => {
    void loadWorlds();
    void loadCharacters();
  }, [loadWorlds, loadCharacters]);

  const onExport = async (): Promise<void> => {
    setExporting(true);
    setFailure(undefined);
    setExported(undefined);
    try {
      // The export is the WHOLE library, so the ids come from the store the screen already
      // shows. The two calls are sequential because a half-loaded library would produce a
      // package that silently omits the rows that had not arrived yet.
      await loadWorlds();
      await loadCharacters();
      const pack = await exportLibraryPack({
        storage: packStorage(),
        worldIds: useContentStore.getState().worlds.map((world) => world.id),
        characterIds: useContentStore.getState().characters.map((character) => character.id),
      });
      downloadBytes(pack.bytes, pack.fileName);
      setExported(pack.fileName);
    } catch (cause) {
      setFailure(t('pack.exportFailed', { detail: reasonOf(cause) }));
    } finally {
      setExporting(false);
    }
  };

  /**
   * Preview bytes through the real importer. Everything else on this screen arrives here.
   *
   * The reset happens first so a second import cannot show the previous report while the new
   * one is still being read: a stale "nothing written yet" panel over a new file would be a
   * false statement about the file on screen.
   */
  const preview = async (bytes: Uint8Array, fileName: string): Promise<void> => {
    setBusy(true);
    setFailure(undefined);
    setReport(undefined);
    setPending(undefined);
    setPhase('idle');
    setStarted(undefined);
    setStartDraft(undefined);
    setStartFailure(undefined);
    try {
      const next = await previewPack({ bytes, storage: packStorage() });
      setPending({ bytes, fileName });
      setReport(next);
      setPhase('preview');
    } catch (cause) {
      setFailure(t('pack.fileUnreadable', { detail: reasonOf(cause) }));
    } finally {
      setBusy(false);
    }
  };

  const onPickFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const input = event.target;
    const file = input.files?.[0];
    // Clearing the control is what lets the same file be picked twice: without it the second
    // `change` never fires, because the value did not change.
    input.value = '';
    if (file === undefined) return;
    try {
      await preview(new Uint8Array(await file.arrayBuffer()), file.name);
    } catch (cause) {
      setFailure(t('pack.fileUnreadable', { detail: reasonOf(cause) }));
    }
  };

  const onPickExample = async (): Promise<void> => {
    setBusy(true);
    try {
      const example = await examplePackBytes();
      await preview(example.bytes, example.fileName);
    } catch (cause) {
      setFailure(t('pack.fileUnreadable', { detail: reasonOf(cause) }));
    } finally {
      setBusy(false);
    }
  };

  const onConfirm = async (): Promise<void> => {
    if (pending === undefined) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const result = await importPack({ bytes: pending.bytes, storage: packStorage() });
      setReport(result);
      setPhase('done');
      // The libraries are refreshed before the result is acted on, so 「打开世界库」 opens a
      // list that already contains what was just written.
      await loadWorlds();
      await loadCharacters();
      setStartDraft(result.ok ? await exampleSessionDraft(result) : undefined);
    } catch (cause) {
      setFailure(t('pack.fileUnreadable', { detail: reasonOf(cause) }));
    } finally {
      setBusy(false);
    }
  };

  const onCancel = (): void => {
    setPending(undefined);
    setReport(undefined);
    setPhase('idle');
    setFailure(undefined);
  };

  const onStartExample = async (): Promise<void> => {
    if (startDraft === undefined) return;
    setBusy(true);
    setStartFailure(undefined);
    try {
      // The app's own creation path (`state/chat-store.ts`), which validates the pins and
      // writes the session — not a second session builder living on this screen.
      const sessionId = await useChatStore.getState().create(startDraft);
      if (sessionId === undefined) {
        setStartFailure(t('pack.startFailed', { detail: t('pack.startExampleUnavailable') }));
        return;
      }
      setStarted(sessionId);
      await navigate({ to: '/play/$sessionId', params: { sessionId } });
    } catch (cause) {
      setStartFailure(t('pack.startFailed', { detail: reasonOf(cause) }));
    } finally {
      setBusy(false);
    }
  };

  const empty = worlds.length === 0 && characters.length === 0;
  const showExample = phase === 'done' && report !== undefined && isExamplePack(report);

  return (
    <>
      <h2 className="section-title">{t('pack.title')}</h2>
      <p className="muted">{t('pack.hint')}</p>
      <p className="muted">{t('pack.exampleWhy')}</p>

      <section>
        <h3 className="section-title">{t('pack.exportTitle')}</h3>
        <p className="muted">{t('pack.exportHint')}</p>
        <div className="btn-row">
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => void onExport()}
            disabled={exporting || empty}
          >
            {t('pack.exportButton')}
          </button>
        </div>
        {empty ? <p className="muted">{t('pack.exportEmpty')}</p> : null}
        {exported === undefined ? null : (
          <p className="muted">{t('pack.exported', { name: exported })}</p>
        )}
      </section>

      <section>
        <h3 className="section-title">{t('pack.importTitle')}</h3>
        <p className="muted">{t('pack.importHint')}</p>
        <div className="btn-row">
          <label className="sr-only" htmlFor="pack-file">
            {t('pack.chooseFile')}
          </label>
          <input
            id="pack-file"
            type="file"
            accept={PACK_ACCEPT}
            onChange={(event) => void onPickFile(event)}
            disabled={busy}
          />
          <button
            className="btn"
            type="button"
            onClick={() => void onPickExample()}
            disabled={busy}
          >
            {t('pack.importExample')}
          </button>
        </div>
      </section>

      {failure === undefined ? null : <p className="error">{failure}</p>}

      {report === undefined ? null : (
        <section>
          <ImportReportView
            report={report}
            title={phase === 'preview' ? 'pack.previewTitle' : 'pack.resultTitle'}
            hint={phase === 'preview' ? 'pack.previewHint' : 'pack.resultHint'}
          />
          {phase === 'preview' ? (
            <div className="btn-row">
              <button
                className="btn btn-primary"
                type="button"
                onClick={() => void onConfirm()}
                disabled={busy || pending === undefined}
              >
                {t('pack.confirm')}
              </button>
              <button className="btn" type="button" onClick={onCancel} disabled={busy}>
                {t('pack.cancel')}
              </button>
            </div>
          ) : (
            <>
              <div className="btn-row">
                <Link className="btn" to="/worlds">
                  {t('pack.openWorlds')}
                </Link>
                <Link className="btn" to="/characters">
                  {t('pack.openCharacters')}
                </Link>
              </div>
              {showExample ? (
                <div className="btn-row">
                  {startDraft === undefined ? (
                    <p className="muted">{t('pack.startExampleUnavailable')}</p>
                  ) : (
                    <button
                      className="btn btn-primary"
                      type="button"
                      onClick={() => void onStartExample()}
                      disabled={busy || started !== undefined}
                    >
                      {t('pack.startExample')}
                    </button>
                  )}
                  <p className="muted">{t('pack.startExampleHint')}</p>
                </div>
              ) : null}
            </>
          )}
          {startFailure === undefined ? null : <p className="error">{startFailure}</p>}
        </section>
      )}
    </>
  );
}
