import path from 'node:path';
import { check } from './contracts.mjs';
import { EventJournal } from './event-journal.mjs';
import { startHttpApi } from './http-api.mjs';
import { SessionService } from './session-store.mjs';
import { WorkBuddyAdapter } from './workbuddy-adapter.mjs';

export async function mountNativeBridge({ daemon, getIdentity, dataRoot, token, allowedWorkspaces, port, limits } = {}) {
  check(typeof dataRoot === 'string' && path.isAbsolute(dataRoot), 'absolute_data_root_required');
  const adapter = new WorkBuddyAdapter({ daemon, getIdentity, dataRoot });
  let journal;
  try {
    journal = new EventJournal(dataRoot, { maxBytes: limits?.journalBytes });
    const service = new SessionService(adapter, journal, { allowedWorkspaces, limits, allowBypassPermissions: false });
    const api = await startHttpApi(service, { token, port, nativeOnly: true });
    let closing;
    return {
      url: api.url,
      close() {
        closing ??= service.close().then(async () => {
          try { await api.close(); }
          finally { adapter.dispose(); journal.close(); }
        }, error => {
          closing = undefined;
          throw error;
        });
        return closing;
      }
    };
  } catch (error) {
    adapter.dispose();
    journal?.close();
    throw error;
  }
}
