/** Utility to replace Playwright's deprecated waitForTimeout */
const delay = (ms: number) => {
  return new Promise((resolve) => {
    return setTimeout(resolve, ms);
  });
};

export default delay;
