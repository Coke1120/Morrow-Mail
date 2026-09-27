// Canonical static data is shared with the Rust service. Keep runtime timezone local.
import catalog from '../rust/resources/catalog.json' with { type: 'json' };

export const AI_BEHAVIORS = structuredClone(catalog.features);
export const DEFAULT_POLICY = structuredClone(catalog.policy);
DEFAULT_POLICY.summarySchedule.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
export const DEFAULT_PREFERENCES = structuredClone(catalog.preferences);
export const DEFAULT_SKILLS = structuredClone(catalog.skills);

export function matchesAITrigger(policy, trigger, message) {
  const action = { onOpen: 'summary', onReply: 'reply', onArrival: 'summary' }[trigger];
  return !!(action && policy.enabled && policy.triggers?.[trigger] && policy.behaviors[action] && message &&
    !['drafts', 'trash'].includes(message.folder) && policy.folders[message.folder] &&
    (!policy.triggers.inboxOnly || message.folder === 'inbox') && (!policy.triggers.starredOnly || message.starred) &&
    ['subject', 'body', 'sender'].some(key => policy.content[key]));
}
