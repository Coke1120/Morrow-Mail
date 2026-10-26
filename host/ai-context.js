const { AsyncLocalStorage } = require("async_hooks");
const context = new AsyncLocalStorage();
module.exports = {
  background: (work) => context.run({ ...context.getStore(), background: true }, work),
  isBackground: () => context.getStore()?.background === true,
  operation: (work) => context.getStore()?.stamp ? work() : context.run({ ...context.getStore(), stamp: require("./ai-consent").getConsent().stamp() }, work),
  stamp: () => context.getStore()?.stamp,
};
