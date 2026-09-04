// Preload: the only bridge between renderer and main. Sandbox-compatible (CJS, electron only).
// Exposes exactly `invoke` and `on` with a channel whitelist that mirrors the frozen contract
// in src/shared/types.d.ts (InvokeMap / EventMap keys). PLAN §3, §12.3; PLAN-v2 §3 adds
// config:defaultPrompt, instance:close, logs:openContracts, shell:openExternal (invoke) and
// console:add, console:remove (events). TODO(v2-A): ipc.ts::INVOKE_CHANNELS + handlers (§14 A6).

import { contextBridge, ipcRenderer } from 'electron';

const INVOKE = new Set<string>([
  'app:getInfo',
  'key:set',
  'key:importFromOpencode',
  'key:clear',
  'models:list',
  'config:get',
  'config:update',
  'config:completeSetup',
  'config:addAgent',
  'config:updateAgent',
  'config:removeAgent',
  'config:defaultPrompt',
  'config:chooseWorkspace',
  'config:resetAll',
  'chat:send',
  'chat:cancel',
  'agent:cancel',
  'agent:clearHistory',
  'instance:close',
  'console:getEvents',
  'console:clear',
  'runtime:getSnapshot',
  'permission:respond',
  'askUser:respond',
  'shell:openPath',
  'logs:openContracts',
  'shell:openExternal',
]);

const EVENTS = new Set<string>([
  'config:changed',
  'console:event',
  'console:patch',
  'console:add',
  'console:remove',
  'agent:status',
  'permission:request',
  'permission:resolved',
  'askUser:request',
  'askUser:resolved',
  'run:finished',
  'app:toast',
]);

contextBridge.exposeInMainWorld('api', {
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> =>
    (INVOKE.has(channel)
      ? ipcRenderer.invoke(channel, ...args)
      : Promise.reject(new Error(`bad channel ${channel}`))),

  on: (channel: string, cb: (payload: unknown) => void): (() => void) => {
    if (!EVENTS.has(channel)) throw new Error(`bad channel ${channel}`);
    const handler = (_e: unknown, payload: unknown): void => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => { ipcRenderer.removeListener(channel, handler); };
  },
});
