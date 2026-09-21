// Thin fetch wrapper shared by both labs. Keeps timeout, JSON decoding and
// error shaping in one place so views only deal with data or a thrown Error.

const TIMEOUT_MS = 12000;

export async function api(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });

  let data;
  try {
    data = await response.json();
  } catch {
    throw Error('Backend unavailable. Start the lab service to connect.');
  }

  if (!response.ok) {
    const error = Error(
      response.status === 429
        ? 'Rate-limited. Wait 60 seconds before retrying.'
        : data.error || 'Backend unavailable',
    );
    error.status = response.status;
    throw error;
  }

  return data;
}
