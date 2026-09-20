import axios from "axios";

const baseURL = import.meta.env.VITE_API_URL || "http://localhost:5000";

export const api = axios.create({ baseURL });

export async function searchProducts(q, page = 1, pageSize = 20) {
  const { data } = await api.get("/api/products/search", { params: { q, page, pageSize } });
  return data;
}

export async function listTrackedProducts() {
  const { data } = await api.get("/api/tracked-products");
  return data.items || [];
}

export async function trackProduct({ name, url, imageUrl }) {
  const { data } = await api.post("/api/tracked-products", { name, url, imageUrl });
  return data.item;
}

export async function getHistory(trackedId) {
  const { data } = await api.get(`/api/tracked-products/${trackedId}/history`);
  return data.history || [];
}

export async function getLogs(trackedId) {
  const { data } = await api.get(`/api/tracked-products/${trackedId}/logs`);
  return data.logs || [];
}

export async function scrapeNow(trackedId) {
  const { data } = await api.post(`/api/tracked-products/${trackedId}/scrape`);
  return data;
}

export async function untrackProduct(trackedId) {
  const { data } = await api.delete(`/api/tracked-products/${trackedId}`);
  return data.item;
}
