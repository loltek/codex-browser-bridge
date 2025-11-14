import { setActionIconActive } from './icon-helper.js';
import {
  queryActiveTab,
  simulateTrustedClickOnPosition,
  simulateKeyboardInput,
  simulateTrustedClickOnElement,
  evaluateScriptInTab,
} from './input-simulators.js';

const API_BASE_URL = 'https://codex-browser-bridge.loltek.net/api3.php';
const POLL_INTERVAL_MS = 1000; // poll for new commands every 1 second.
const CLIENT_PARAM_KEY = 'client';
const CLIENT_PARAM_VALUE = 'extension';
const sessions = new Map();
const SESSION_STORAGE_KEY = 'active_sessions';
const KEEP_ALIVE_PORT_NAME = 'codex-keep-alive';
const keepAlivePorts = new Map();

function buildApiUrl() {
  const url = new URL(API_BASE_URL);
  url.searchParams.set(CLIENT_PARAM_KEY, CLIENT_PARAM_VALUE);
  return url;
}

function getStoredSessions() {
  return new Promise((resolve) => {
    chrome.storage.local.get(SESSION_STORAGE_KEY, (result) => {
      if (chrome.runtime.lastError) {
        console.warn('Failed to read stored sessions', chrome.runtime.lastError.message);
        resolve({});
        return;
      }
      const stored = result[SESSION_STORAGE_KEY];
      if (!stored || typeof stored !== 'object') {
        resolve({});
        return;
      }
      resolve(stored);
    });
  });
}

function saveStoredSessions(entries) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [SESSION_STORAGE_KEY]: entries }, () => {
      if (chrome.runtime.lastError) {
        console.warn('Failed to save stored sessions', chrome.runtime.lastError.message);
      }
      resolve();
    });
  });
}

async function persistSessionEntry(tabId, sessionKey) {
  const entries = await getStoredSessions();
  entries[tabId] = sessionKey;
  await saveStoredSessions(entries);
}

async function removeSessionEntry(tabId) {
  const entries = await getStoredSessions();
  if (!Object.prototype.hasOwnProperty.call(entries, tabId)) {
    return;
  }
  delete entries[tabId];
  await saveStoredSessions(entries);
}

function releaseKeepAlivePort(tabId) {
  const port = keepAlivePorts.get(tabId);
  if (!port) {
    return;
  }
  keepAlivePorts.delete(tabId);
  try {
    port.disconnect();
  } catch (error) {
    console.warn('Failed to disconnect keep-alive port', error);
  }
}

async function ensureKeepAliveConnection(tabId) {
  if (keepAlivePorts.has(tabId)) {
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const state = window.__codexKeepAlivePort;
        if (state && state.port) {
          return;
        }
        const keepAliveState = { port: null, timerId: null };
        const port = chrome.runtime.connect({ name: 'codex-keep-alive' });
        keepAliveState.port = port;
        const sendPing = () => {
          try {
            port.postMessage({ type: 'keep_alive', timestamp: Date.now() });
          } catch (error) {
            // no-op, disconnect handler will clean up
          }
        };
        keepAliveState.timerId = setInterval(sendPing, 20000);
        sendPing();
        port.onDisconnect.addListener(() => {
          if (keepAliveState.timerId) {
            clearInterval(keepAliveState.timerId);
          }
          if (window.__codexKeepAlivePort === keepAliveState) {
            window.__codexKeepAlivePort = null;
          }
        });
        window.__codexKeepAlivePort = keepAliveState;
      },
    });
  } catch (error) {
    console.warn('Failed to ensure keep-alive connection', error);
  }
}

function ensureInactiveIcon() {
  setActionIconActive(false).catch((error) => {
    console.warn('Could not set toolbar icon inactive:', error);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== KEEP_ALIVE_PORT_NAME) {
    return;
  }
  const tabId = port.sender?.tab?.id;
  if (tabId === undefined) {
    port.disconnect();
    return;
  }
  keepAlivePorts.set(tabId, port);
  port.onDisconnect.addListener(() => {
    if (keepAlivePorts.get(tabId) === port) {
      keepAlivePorts.delete(tabId);
    }
    if (sessions.has(tabId)) {
      ensureKeepAliveConnection(tabId).catch((error) => {
        console.warn('Failed to re-establish keep-alive connection', error);
      });
    }
  });
});

async function createSession() {
  const url = buildApiUrl();
  url.searchParams.set('task', 'create_session');
  const response = await fetch(url.toString(), { method: 'POST' });
  if (!response.ok) {
    throw new Error(`create_session failed (${response.status})`);
  }
  const payload = await response.json();
  if (!payload || !payload.session_key) {
    throw new Error('create_session did not return a session key');
  }
  return payload.session_key;
}

async function fetchCommand(sessionKey) {
  const url = buildApiUrl();
  url.searchParams.set('task', 'fetch_command');
  url.searchParams.set('session_key', sessionKey);
  const response = await fetch(url.toString(), { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`fetch_command failed (${response.status})`);
  }
  return response.json();
}

async function reportCommandResult(sessionKey, data) {
  const url = buildApiUrl();
  url.searchParams.set('task', 'send_response');
  url.searchParams.set('session_key', sessionKey);
  const payload = new URLSearchParams();
  payload.set('status', data.success ? 'success' : 'error');
  payload.set('command', data.command ?? 'unknown');
  let resultJson = '{}';
  try {
    resultJson = JSON.stringify(data);
  } catch {
    // fall back to empty object if serialization fails
  }
  payload.set('result', resultJson);
  const response = await fetch(url.toString(), {
    method: 'POST',
    body: payload,
  });
  if (!response.ok) {
    throw new Error(`send_response failed (${response.status})`);
  }
  return response.json();
}

function stopSession(tabId) {
  const hadSession = sessions.delete(tabId);
  releaseKeepAlivePort(tabId);
  removeSessionEntry(tabId).catch(() => {});
  if (hadSession && sessions.size === 0) {
    setActionIconActive(false).catch(() => {});
  }
}

function getTabById(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tab);
    });
  });
}

async function executeScriptCommand(tabId, command) {
  const response = await evaluateScriptInTab(tabId, command.script ?? '');
  if (!response) {
    return null;
  }
  const { exceptionDetails, result } = response;
  if (exceptionDetails) {
    const description = exceptionDetails.exception?.description
      ?? exceptionDetails.text
      ?? 'Script execution failed';
    throw new Error(description);
  }
  return result?.value ?? null;
}

async function captureScreenshot(tab, command) {
  return new Promise((resolve, reject) => {
    const format = ['jpg', 'jpeg'].includes(command.format) ? 'jpeg' : 'png';
    const options = {
      format,
    };
    if (format === 'jpeg' && command.quality !== undefined) {
      const quality = Number(command.quality);
      if (!Number.isNaN(quality)) {
        options.quality = Math.min(100, Math.max(1, quality));
      }
    }
    chrome.tabs.captureVisibleTab(
      tab.windowId,
      options,
      (dataUrl) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(dataUrl);
      }
    );
  });
}

async function executeCommand(command, tab) {
  const commandType = command?.type ?? 'unknown';
  const result = {
    command: commandType,
    timestamp: new Date().toISOString(),
  };
  try {
    switch (commandType) {
      case 'execute_javascript': {
        const output = await executeScriptCommand(tab.id, command);
        result.success = true;
        result.output = output;
        break;
      }
      case 'mouse_click_position': {
        const x = Number(command.pos_x);
        const y = Number(command.pos_y);
        if (Number.isNaN(x) || Number.isNaN(y)) {
          throw new Error('click_on_position missing coordinates');
        }
        await simulateTrustedClickOnPosition(x, y, 'left', tab.id);
        result.success = true;
        break;
      }
      case 'click_on_element': {
        const selector = typeof command.selector === 'string' ? command.selector : command.css_selector;
        const selectorFunction = typeof command.selector_function === 'string'
          ? command.selector_function
          : command.selectorFunction;
        if ((!selector || selector.trim() === '') && (!selectorFunction || selectorFunction.trim() === '')) {
          throw new Error('click_on_element requires a selector or selector_function');
        }
        const button = typeof command.button === 'string' ? command.button : 'left';
        const clickCount = await simulateTrustedClickOnElement({ selector, selectorFunction }, button, tab.id);
        result.success = true;
        result.selector = selector;
        if (selectorFunction) {
          result.selectorFunction = selectorFunction;
        }
        result.button = button;
        result.clickCount = clickCount;
        break;
      }
      case 'take_screenshot': {
        const screenshot = await captureScreenshot(tab, command);
        result.success = true;
        result.screenshot = screenshot;
        result.format = ['jpg', 'jpeg'].includes(command.format) ? 'jpg' : 'png';
        result.quality = command.quality ?? null;
        break;
      }
      case 'keyboard_input': {
        const textPayload = command.text ?? command.input ?? '';
        const inputText = typeof textPayload === 'string' ? textPayload : String(textPayload ?? '');
        if (!inputText) {
          throw new Error('keyboard_input command is empty');
        }
        await simulateKeyboardInput(inputText, tab.id);
        result.success = true;
        break;
      }
      default:
        throw new Error(`Unsupported command type: ${commandType}`);
    }
  } catch (error) {
    result.success = false;
    result.error = error?.message ?? 'unknown error';
  }
  return result;
}

async function pollCommandsForTab(tabId, sessionKey) {
  while (sessions.has(tabId)) {
    try {
      const payload = await fetchCommand(sessionKey);
      if (payload?.status === 'command') {
        const command = payload.command_data ?? null;
        if (command && typeof command === 'object') {
          let tab;
          try {
            tab = await getTabById(tabId);
          } catch {
            stopSession(tabId);
            return;
          }
          const commandResult = await executeCommand(command, tab);
          await reportCommandResult(sessionKey, commandResult);
        }
      }
    } catch (error) {
      console.warn('Command loop error', error);
    }
    // Sleep for 1 second between polls, ensuring the extension checks for updates at a steady interval.
    await delay(POLL_INTERVAL_MS);
  }
}

async function restoreSessionsFromStorage() {
  const stored = await getStoredSessions();
  let restoredAny = false;
  for (const [tabIdKey, sessionKey] of Object.entries(stored)) {
    const tabId = Number(tabIdKey);
    if (!Number.isInteger(tabId)) {
      continue;
    }
    try {
      await getTabById(tabId);
    } catch {
      removeSessionEntry(tabId).catch(() => {});
      continue;
    }
    sessions.set(tabId, { sessionKey });
    ensureKeepAliveConnection(tabId).catch((error) => {
      console.warn('Failed to restore keep-alive connection', error);
    });
    restoredAny = true;
    pollCommandsForTab(tabId, sessionKey).catch((error) => {
      console.warn('Session polling stopped unexpectedly (restore)', error);
      stopSession(tabId);
    });
  }
  if (restoredAny) {
    setActionIconActive(true).catch(() => {});
  }
}

async function startSession() {
  const tab = await queryActiveTab();
  if (!tab.id) {
    throw new Error('No active tab');
  }
  if (sessions.has(tab.id)) {
    return sessions.get(tab.id).sessionKey;
  }
  const sessionKey = await createSession();
  sessions.set(tab.id, { sessionKey });
  ensureKeepAliveConnection(tab.id).catch((error) => {
    console.warn('Failed to start keep-alive connection', error);
  });
  setActionIconActive(true).catch(() => {});
  persistSessionEntry(tab.id, sessionKey).catch((error) => {
    console.warn('Failed to persist session state', error);
  });
  pollCommandsForTab(tab.id, sessionKey).catch((error) => {
    console.warn('Session polling stopped unexpectedly', error);
    stopSession(tab.id);
  });
  return sessionKey;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'start_session') {
    startSession()
      .then((sessionKey) => sendResponse({ sessionKey }))
      .catch((error) => sendResponse({ error: error?.message ?? 'failed to start session' }));
    return true;
  }
  if (message?.type === 'session_state') {
    const tabId = typeof message.tabId === 'number' ? message.tabId : sender.tab?.id;
    if (tabId === undefined) {
      sendResponse({ active: false });
      return true;
    }
    const entry = sessions.get(tabId);
    sendResponse({
      active: !!entry,
      sessionKey: entry?.sessionKey ?? null,
    });
    return true;
  }
  if (message?.type === 'stop_session') {
    const tabId = sender.tab?.id;
    if (tabId !== undefined) {
      stopSession(tabId);
    }
    sendResponse({ stopped: true });
    return true;
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  stopSession(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!sessions.has(tabId)) {
    return;
  }
  if (changeInfo.status === 'complete') {
    ensureKeepAliveConnection(tabId).catch((error) => {
      console.warn('Failed to reapply keep-alive after navigation', error);
    });
  }
});

chrome.runtime.onInstalled.addListener(() => {
  ensureInactiveIcon();
});

chrome.runtime.onStartup.addListener(() => {
  ensureInactiveIcon();
});

ensureInactiveIcon();
restoreSessionsFromStorage().catch((error) => {
  console.warn('Failed to restore session state', error);
});
