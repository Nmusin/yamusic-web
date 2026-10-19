// API helper functions
export async function jsonFetch(url, opts) {
  const res = await fetch(url, opts);
  return await res.json();
}

export async function apiGet(url) {
  return jsonFetch(url);
}

export async function apiPost(url, body) {
  return jsonFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
