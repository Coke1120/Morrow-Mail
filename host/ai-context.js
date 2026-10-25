const { AsyncLocalStorage } = require("async_hooks");
const context = new AsyncLocalStorage();
module.exports = {
  background: (work) => context.run({ background: true }, work),
  isBackground: () => context.getStore()?.background === true,
};
