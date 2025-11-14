const ICON_URL = chrome.runtime.getURL('hello_extensions.png');

const iconCache = {
  active: null,
  inactive: null,
};

async function loadBaseIconBitmap() {
  const response = await fetch(ICON_URL);
  if (!response.ok) {
    throw new Error(`Failed to load icon (${response.status})`);
  }
  const blob = await response.blob();
  return await createImageBitmap(blob);
}

function createDrawingSurface(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    return canvas;
  }
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new Error('No drawing surface available for icon generation');
}

function createIconImageData(bitmap, filter) {
  const canvas = createDrawingSurface(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not acquire 2D context for icon');
  }
  ctx.filter = filter;
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

async function ensureIconData() {
  if (iconCache.active && iconCache.inactive) {
    return;
  }
  const bitmap = await loadBaseIconBitmap();
  iconCache.inactive = createIconImageData(bitmap, 'grayscale(1) brightness(0.8)');
  iconCache.active = createIconImageData(bitmap, 'grayscale(0) drop-shadow(0 0 8px #28a745)');
}

export async function setActionIconActive(active) {
  if (!chrome.action || !chrome.action.setIcon) {
    return;
  }
  try {
    await ensureIconData();
    const imageData = active ? iconCache.active : iconCache.inactive;
    if (!imageData) {
      return;
    }
    chrome.action.setIcon({ imageData }, () => {
      if (chrome.runtime.lastError) {
        console.warn('chrome.action.setIcon failed', chrome.runtime.lastError.message);
      }
    });
  } catch (error) {
    console.warn('Failed to update toolbar icon', error);
  }
}
