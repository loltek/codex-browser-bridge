import { queryActiveTab, simulateTrustedClickOnElement } from './input-simulators.js';

const TARGET_SELECTOR = 'body';
const API_BASE_URL = 'https://codex-browser-bridge.loltek.net/api3.php';
const CLIENT_PARAM_KEY = 'client';
const CLIENT_PARAM_VALUE = 'extension';

function buildApiUrl() {
  const url = new URL(API_BASE_URL);
  url.searchParams.set(CLIENT_PARAM_KEY, CLIENT_PARAM_VALUE);
  return url;
}

function buildCodexUpdateCommand(sessionKey) {
  const url = new URL(API_BASE_URL);
  url.searchParams.set('session_key', sessionKey);
  return `run curl '${url.toString()}'`;
}

function startRemoteSession() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'start_session' }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response) {
        reject(new Error('Failed to start session'));
        return;
      }
      if (response.error) {
        reject(new Error(response.error));
        return;
      }
      resolve(response.sessionKey);
    });
  });
}

function stopRemoteSession() {
  chrome.runtime.sendMessage({ type: 'stop_session' }, () => {});
}

function initializePopup() {
  const toggleBtn = document.getElementById('toggle-access');
  const statusEl = document.getElementById('status');
  const logoEl = document.getElementById('logo');
  const instructionsEl = document.getElementById('instructions');
  const commandInput = document.getElementById('codex-command');
  const copyBtn = document.getElementById('copy-command');

  let currentSessionKey = null;
  let isActive = false;

  function updateToggleButton() {
    if (!toggleBtn) {
      return;
    }
    toggleBtn.textContent = isActive ? 'Disable Codex Access' : 'Enable Codex Access';
    toggleBtn.classList.toggle('inactive', !isActive);
  }

  function setToggleState(enabled, sessionKey = null) {
    isActive = enabled;
    currentSessionKey = sessionKey;
    updateToggleButton();
  }

  function updateStatus(message, isError = false) {
    if (!statusEl) {
      return;
    }
    statusEl.textContent = message;
    statusEl.classList.toggle('error', isError);
  }

  function setLogoActive(active) {
    if (!logoEl) {
      return;
    }
    logoEl.classList.toggle('active', active);
  }

  async function copyCommandToClipboard() {
    if (!commandInput || !commandInput.value) {
      return;
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(commandInput.value);
      } else {
        commandInput.select();
        document.execCommand('copy');
        const selection = window.getSelection ? window.getSelection() : null;
        if (selection) {
          selection.removeAllRanges();
        }
      }
      updateStatus('Command copied to clipboard.');
    } catch (error) {
      console.warn('Copy to clipboard failed', error);
      updateStatus('Copy failed; select text manually.', true);
    }
  }

  async function requestSessionState() {
    try {
      const tab = await queryActiveTab();
      if (!tab.id) {
        return null;
      }
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'session_state', tabId: tab.id }, (response) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(response);
        });
      });
    } catch (error) {
      console.warn('Could not fetch session state', error);
      return null;
    }
  }

  function showInstructions(sessionKey) {
    if (!instructionsEl) {
      return;
    }
    instructionsEl.hidden = false;
    if (commandInput) {
      commandInput.value = buildCodexUpdateCommand(sessionKey);
    }
  }

  function hideInstructions() {
    if (!instructionsEl) {
      return;
    }
    instructionsEl.hidden = true;
    if (commandInput) {
      commandInput.value = '';
    }
  }

  setLogoActive(false);
  hideInstructions();
  setToggleState(false);

  if (copyBtn) {
    copyBtn.addEventListener('click', (event) => {
      event.preventDefault();
      copyCommandToClipboard();
    });
  }

  if (toggleBtn) {
    toggleBtn.addEventListener('click', async () => {
      if (isActive) {
        updateStatus('Codex access disabled.');
        stopRemoteSession();
        setLogoActive(false);
        hideInstructions();
        setToggleState(false);
        return;
      }
      updateStatus('Granting Codex access to this tab...');
      toggleBtn.disabled = true;
      hideInstructions();
      try {
        const sessionKey = await startRemoteSession();
        await simulateTrustedClickOnElement(TARGET_SELECTOR);
        showInstructions(sessionKey);
        updateStatus('Codex can now issue trusted clicks on this tab.');
        console.log('User granted Codex access to this tab');
        setLogoActive(true);
        setToggleState(true, sessionKey);
      } catch (error) {
        hideInstructions();
        console.error('Failed to simulate trusted click', error);
        updateStatus(
          `Failed to grant access: ${error?.message ?? 'unknown error'}`,
          true
        );
        setLogoActive(false);
        setToggleState(false);
      } finally {
        toggleBtn.disabled = false;
      }
    });
  }

  async function restoreSessionState() {
    const state = await requestSessionState();
    if (state?.active && state.sessionKey) {
      showInstructions(state.sessionKey);
      updateStatus('Codex can now issue trusted clicks on this tab.');
      setLogoActive(true);
      setToggleState(true, state.sessionKey);
      return;
    }
    setToggleState(false);
  }

  restoreSessionState();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializePopup);
} else {
  initializePopup();
}
