// localStorage helpers that never throw (private mode, quota, disabled storage).
// All keys are defined at the top of src/App.jsx.

export function readString(key, fallback = null) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

export function readJSON(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

export function writeString(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore storage errors
  }
}

export function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage/serialization errors
  }
}

export function removeKey(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore storage errors
  }
}
