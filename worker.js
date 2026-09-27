// Cloudflare Worker — CS2 Bet API на D1
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json"
};
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: CORS });

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const path = new URL(request.url).pathname;

    try {
      // HEALTH
      if (path === "/api/health") {
        return json({ ok: true, t: Date.now() });
      }

      // GET BALANCE
      if (path === "/api/balance" && request.method === "POST") {
        const { user_id } = await request.json();
        if (!user_id) return json({ error: "user_id required" }, 400);

        let row = await env.DB.prepare(
          "SELECT balance FROM balances WHERE user_id=?"
        ).bind(String(user_id)).first();

        if (!row) {
          await env.DB.prepare(
            "INSERT INTO balances (user_id,balance) VALUES (?,0)"
          ).bind(String(user_id)).run();
          row = { balance: 0 };
        }
        return json({ balance: Number(row.balance) || 0 });
      }

      // CHANGE BALANCE
      if (path === "/api/balance/change" && request.method === "POST") {
        const { user_id, amount } = await request.json();
        if (!user_id || typeof amount !== "number") {
          return json({ error: "user_id and amount required" }, 400);
        }

        let row = await env.DB.prepare(
          "SELECT balance FROM balances WHERE user_id=?"
        ).bind(String(user_id)).first();

        if (!row) {
          await env.DB.prepare(
            "INSERT INTO balances (user_id,balance) VALUES (?,0)"
          ).bind(String(user_id)).run();
          row = { balance: 0 };
        }

        let nb = Number(row.balance) + amount;
        if (nb < 0) nb = 0;

        await env.DB.prepare(
          "UPDATE balances SET balance=? WHERE user_id=?"
        ).bind(nb, String(user_id)).run();

        return json({ balance: nb });
      }

      // GET INVENTORY
      if (path === "/api/inventory" && request.method === "POST") {
        const { user_id } = await request.json();
        if (!user_id) return json({ error: "user_id required" }, 400);

        const { results } = await env.DB.prepare(
          "SELECT * FROM inventory WHERE user_id=? ORDER BY id DESC"
        ).bind(String(user_id)).all();

        const items = (results || []).map(r => ({
          id: r.id,
          skinId: r.skin_id,
          name: r.name,
          weapon: r.weapon,
          rarity: r.rarity,
          wear: r.wear,
          wearName: r.wear_name,
          statTrak: !!r.stat_trak,
          price: Number(r.price) || 0,
        }));

        return json({ items });
      }

      // ADD TO INVENTORY
      if (path === "/api/inventory/add" && request.method === "POST") {
        const b = await request.json();
        const {
          user_id, skinId, name, weapon, rarity,
          wear, wearName, statTrak, price
        } = b;

        if (!user_id || !name) {
          return json({ error: "user_id and name required" }, 400);
        }

        const r = await env.DB.prepare(
          `INSERT INTO inventory
           (user_id, skin_id, name, weapon, rarity, wear, wear_name, stat_trak, price)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          String(user_id),
          String(skinId || ""),
          String(name),
          String(weapon || "rifle"),
          String(rarity || "consumer"),
          String(wear || "FN"),
          String(wearName || "Factory New"),
          statTrak ? 1 : 0,
          Number(price) || 0
        ).run();

        return json({ ok: true, id: r.meta.last_row_id });
      }

      // REMOVE (без начисления — для апгрейдера)
      if (path === "/api/inventory/remove" && request.method === "POST") {
        const { user_id, id } = await request.json();
        if (!user_id || !id) return json({ error: "user_id and id required" }, 400);

        await env.DB.prepare(
          "DELETE FROM inventory WHERE id=? AND user_id=?"
        ).bind(Number(id), String(user_id)).run();

        return json({ ok: true });
      }

      // SELL (удаляет + начисляет)
      if (path === "/api/inventory/sell" && request.method === "POST") {
        const { user_id, id } = await request.json();
        if (!user_id || !id) return json({ error: "user_id and id required" }, 400);

        const item = await env.DB.prepare(
          "SELECT * FROM inventory WHERE id=? AND user_id=?"
        ).bind(Number(id), String(user_id)).first();

        if (!item) return json({ error: "not found" }, 404);

        await env.DB.prepare(
          "DELETE FROM inventory WHERE id=? AND user_id=?"
        ).bind(Number(id), String(user_id)).run();

        let row = await env.DB.prepare(
          "SELECT balance FROM balances WHERE user_id=?"
        ).bind(String(user_id)).first();

        if (!row) {
          await env.DB.prepare(
            "INSERT INTO balances (user_id,balance) VALUES (?,0)"
          ).bind(String(user_id)).run();
          row = { balance: 0 };
        }

        const nb = Number(row.balance) + Number(item.price);
        await env.DB.prepare(
          "UPDATE balances SET balance=? WHERE user_id=?"
        ).bind(nb, String(user_id)).run();

        return json({ ok: true, balance: nb, sold: Number(item.price) || 0 });
      }

      return json({ error: "not found", path }, 404);
    } catch (e) {
      return json({ error: String(e && e.message ? e.message : e) }, 500);
    }
  }
};
