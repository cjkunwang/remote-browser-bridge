export function grantOptionsFromMessage(message = {}) {
  return {
    scope: message.scope,
    durationMinutes: message.durationMinutes,
    origin: message.origin || null,
    tabId: Number.isInteger(message.tabId) && message.tabId > 0 ? message.tabId : null
  };
}
