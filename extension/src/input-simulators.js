function queryActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ currentWindow: true, active: true }, (tabs) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!tabs.length || tabs[0].id === undefined) {
        reject(new Error('No active tab found'));
        return;
      }
      resolve(tabs[0]);
    });
  });
}

function executeScriptInTab(tabId, func, args = []) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        func,
        args,
      },
      (results) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(results);
      }
    );
  });
}

function attachDebugger(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, '1.3', () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function detachDebugger(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.detach(target, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function dispatchMouseEvent(target, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', params, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function dispatchKeyEvent(target, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', params, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

async function simulateTrustedClickOnPosition(x, y, button = 'left', tabId = null) {
  const resolvedTabId = tabId ?? (await queryActiveTab()).id;
  if (resolvedTabId === undefined) {
    throw new Error('No tab id available for trusted click');
  }
  const debuggee = { tabId: resolvedTabId };
  await attachDebugger(debuggee);
  try {
    await dispatchMouseEvent(debuggee, { type: 'mouseMoved', x, y });
    await dispatchMouseEvent(debuggee, {
      type: 'mousePressed',
      button,
      x,
      y,
      clickCount: 1,
    });
    await dispatchMouseEvent(debuggee, {
      type: 'mouseReleased',
      button,
      x,
      y,
      clickCount: 1,
    });
  } finally {
    try {
      await detachDebugger(debuggee);
    } catch (err) {
      console.warn('Failed to detach debugger after mouse event', err);
    }
  }
}

async function simulateTrustedClickOnElement(target, button = 'left', tabId = null) {
  const resolvedTabId = tabId ?? (await queryActiveTab()).id;
  if (resolvedTabId === undefined) {
    throw new Error('No tab id available for trusted element click');
  }
  let selector = null;
  let selectorFunction = null;
  if (typeof target === 'string') {
    selector = target;
  } else if (target && typeof target === 'object') {
    if (typeof target.selector === 'string') {
      selector = target.selector;
    }
    if (typeof target.selectorFunction === 'string') {
      selectorFunction = target.selectorFunction;
    }
  }
  if (!selector && !selectorFunction) {
    throw new Error('click_on_element requires a selector or selector_function');
  }
  const script = `(() => {
    const selector = ${selector ? JSON.stringify(selector) : 'null'};
    const selectorFn = ${selectorFunction ? `(${selectorFunction})` : 'null'};
    const collectElements = (value, sink) => {
      if (!value) {
        return;
      }
      if (value instanceof Element) {
        sink.push(value);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((entry) => collectElements(entry, sink));
        return;
      }
      if (value instanceof NodeList || value instanceof HTMLCollection) {
        Array.from(value).forEach((entry) => collectElements(entry, sink));
      }
    };
    const elements = [];
    if (selectorFn) {
      try {
        collectElements(selectorFn(), elements);
      } catch (error) {
        return { error: error?.message ?? 'selector_function failed' };
      }
    }
    if (selector) {
      collectElements(document.querySelectorAll(selector), elements);
    }
    if (!elements.length) {
      return null;
    }
    return {
      rects: elements.map((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          left: bounds.left,
          top: bounds.top,
          width: bounds.width,
          height: bounds.height,
        };
      }),
    };
  })()`;
  const evalResult = await evaluateScriptInTab(resolvedTabId, script);
  if (!evalResult) {
    throw new Error('Failed to evaluate selector');
  }
  const { exceptionDetails, result } = evalResult;
  if (exceptionDetails) {
    const description = exceptionDetails.exception?.description
      ?? exceptionDetails.text
      ?? 'selector evaluation failed';
    throw new Error(description);
  }
  const value = result?.value ?? null;
  if (!value || !Array.isArray(value.rects) || value.rects.length === 0) {
    const errorMessage = value?.error
      ?? (selectorFunction ? 'selector_function did not return an element' : `Element ${selector} not found`);
    throw new Error(errorMessage);
  }
  if (value.rects.length > 1) {
    throw new Error(`Selector matched ${value.rects.length} elements; return exactly one element`);
  }
  const rect = value.rects[0];
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  await simulateTrustedClickOnPosition(x, y, button, resolvedTabId);
  return 1;
}

function buildKeyboardEventParams(char) {
  const upperChar = char.toUpperCase();
  const keyCode = upperChar.charCodeAt(0);
  return {
    key: char,
    code: /^[A-Z]$/.test(upperChar) ? `Key${upperChar}` : undefined,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    text: char,
    unmodifiedText: char,
  };
}

async function simulateKeyboardInput(text, tabId = null) {
  if (!text) {
    return;
  }
  const resolvedTabId = tabId ?? (await queryActiveTab()).id;
  if (resolvedTabId === undefined) {
    throw new Error('No tab id available for trusted keyboard input');
  }
  const debuggee = { tabId: resolvedTabId };
  await attachDebugger(debuggee);
  try {
    for (const char of text) {
      const params = buildKeyboardEventParams(char);
      await dispatchKeyEvent(debuggee, { type: 'keyDown', ...params });
      await dispatchKeyEvent(debuggee, { type: 'char', ...params });
      await dispatchKeyEvent(debuggee, { type: 'keyUp', ...params });
    }
  } finally {
    try {
      await detachDebugger(debuggee);
    } catch (err) {
      console.warn('Failed to detach debugger after keyboard event', err);
    }
  }
}

function runtimeEvaluate(target, expression) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(
      target,
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
      },
      (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(result);
      }
    );
  });
}

async function evaluateScriptInTab(tabId, expression) {
  const debuggee = { tabId };
  await attachDebugger(debuggee);
  try {
    return await runtimeEvaluate(debuggee, expression ?? '');
  } finally {
    try {
      await detachDebugger(debuggee);
    } catch (err) {
      console.warn('Failed to detach debugger after script evaluation', err);
    }
  }
}

export {
  queryActiveTab,
  executeScriptInTab,
  evaluateScriptInTab,
  simulateTrustedClickOnElement,
  simulateTrustedClickOnPosition,
  simulateKeyboardInput,
};
