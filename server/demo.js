import catalog from '../rust/resources/catalog.json' with { type: 'json' };

export function createDemoMessages(now = Date.now()) {
  return structuredClone(catalog.demo).map(message => {
    // Canonical fixture dates are relative to Unix epoch, exactly as createDemoMessages(0).
    const age = -Date.parse(message.date);
    message.date = new Date(now - age).toISOString();
    return message;
  });
}
