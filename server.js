const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json());

const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID;
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET;

let cachedToken = null;
 tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const credentials = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString("base64");
  const res = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("Token error: " + JSON.stringify(data));
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

app.get("/", (req, res) => res.json({ status: "SCOUT BACKEND ONLINE" }));

app.get("/search", async (req, res) => {
  try {
    const { q, budget, limit = 10 } = req.query;
    if (!q) return res.status(400).json({ error: "query param 'q' required" });

    const token = await getAccessToken();
    const filters = ["priceCurrency:USD"];
    if (budget) filters.push(`price:[..${budget}]`);

    const params = new URLSearchParams({ q, limit, sort: "newlyListed", filter: filters.join(",") });
    const ebayRes = await fetch(
      `https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`,
      {
        headers: {
          "Authorization": `Bearer ${token}`,
          "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
          "Content-Type": "application/json",
        },
      }
    );

    const data = await ebayRes.json();
    if (!data.itemSummaries) return res.json({ items: [], total: 0 });

    const items = data.itemSummaries.map((item) => {
      const price = parseFloat(item.price?.value || 0);
      const condition = item.condition || "Unknown";
      const riskLevel = estimateRisk(item, condition);
      return {
        id: item.itemId,
        title: item.title,
        price,
        originalValue: Math.round(price * getValueMultiplier(item)),
        bids: item.bidCount || 0,
        timeLeft: item.itemEndDate ? getTimeLeft(item.itemEndDate) : "Buy It Now",
        condition,
        category: item.categories?.[0]?.categoryName || "General",
        location: item.itemLocation?.city ? `${item.itemLocation.city}, ${item.itemLocation.stateOrProvince || ""}` : "USA",
        image: item.image?.imageUrl || null,
        sellThrough: estimateSellThrough(item),
        avgDaysToSell: estimateDaysToSell(item),
        riskLevel,
        weight: estimateWeight(item),
        url: item.itemWebUrl,
        seller: {
          name: item.seller?.username || "-",
          feedback: item.seller?.feedbackPercentage || "-",
          score: item.seller?.feedbackScore || 0,
        },
        notes: generateNotes(item, riskLevel),
      };
    });

    items.sort((a, b) => b.sellThrough - a.sellThrough);
    res.json({ items, total: data.total || items.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

function getTimeLeft(endDateStr) {
  const diff = new Date(endDateStr) - Date.now();
  if (diff <= 0) return "Ended";
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h > 48) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return `${h}h ${m}m`;
}

function estimateSellThrough(item) {
  let score = 70;
  const title = item.title?.toLowerCase() || "";
  if (["dewalt", "milwaukee", "apple", "samsung", "sony", "iphone", "dyson", "nike"].some(k => title.includes(k))) score += 15;
  if (["lot", "bundle", "bulk", "wholesale", "liquidation"].some(k => title.includes(k))) score += 5;
  if (item.bidCount > 10) score += 8;
  if (item.bidCount > 20) score += 5;
  return Math.min(score, 99);
}

function estimateRisk(item, condition) {
  const cond = condition.toLowerCase();
  if (cond.includes("new") || cond.includes("sealed")) return "low";
  if (cond.includes("parts") || cond.includes("broken")) return "high";
  if (item.seller?.feedbackPercentage && parseFloat(item.seller.feedbackPercentage) < 95) return "high";
  return "medium";
}

function getValueMultiplier(item) {
  const title = item.title?.toLowerCase() || "";
  if (title.includes("new") || title.includes("sealed")) return 1.4;
  if (title.includes("used")) return 1.1;
  return 1.25;
}

function estimateDaysToSell(item) {
  const st = estimateSellThrough(item);
  if (st > 85) return "1-3 days";
  if (st > 70) return "4-7 days";
  return "7-14 days";
}

function estimateWeight(item) {
  const title = item.title?.toLowerCase() || "";
  if (["iphone", "phone", "watch"].some(k => title.includes(k))) return "0.5 lbs";
  if (["drill", "tool", "shoes"].some(k => title.includes(k))) return "3-5 lbs";
  return "2 lbs";
}

function generateNotes(item, risk) {
  if (risk === "high") return "Check photos for damage/parts only.";
  if (item.bidCount > 15) return "High demand item, watch bidding.";
  return "Standard market value scout.";
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
