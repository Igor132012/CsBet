// Cloudflare Worker — CS2 Bet API на D1
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json"
};
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: CORS });

const ADMIN_TOKEN = "cs2_secret_change_me"; // ← поменяй на свой секрет

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const path = new URL(request.url).pathname;

    try {
      if (path === "/api/health") return json({ ok: true, t: Date.now() });

      // ============ BALANCE ============
      if (path === "/api/balance" && request.method === "POST") {
        const { user_id } = await request.json();
        if (!user_id) return json({ error: "user_id required" }, 400);
        let row = await env.DB.prepare("SELECT balance FROM balances WHERE user_id=?").bind(String(user_id)).first();
        if (!row) {
          await env.DB.prepare("INSERT INTO balances (user_id,balance) VALUES (?,0)").bind(String(user_id)).run();
          row = { balance: 0 };
        }
        return json({ balance: Number(row.balance) || 0 });
      }

      if (path === "/api/balance/change" && request.method === "POST") {
        const { user_id, amount } = await request.json();
        if (!user_id || typeof amount !== "number") return json({ error: "bad payload" }, 400);
        let row = await env.DB.prepare("SELECT balance FROM balances WHERE user_id=?").bind(String(user_id)).first();
        if (!row) {
          await env.DB.prepare("INSERT INTO balances (user_id,balance) VALUES (?,0)").bind(String(user_id)).run();
          row = { balance: 0 };
        }
        let nb = Number(row.balance) + amount;
        if (nb < 0) nb = 0;
        await env.DB.prepare("UPDATE balances SET balance=? WHERE user_id=?").bind(nb, String(user_id)).run();
        return json({ balance: nb });
      }

      if (path === "/api/balance/deposit" && request.method === "POST") {
        const { user_id, amount } = await request.json();
        if (!user_id || typeof amount !== "number" || amount <= 0) return json({ error: "bad payload" }, 400);
        let row = await env.DB.prepare("SELECT balance FROM balances WHERE user_id=?").bind(String(user_id)).first();
        if (!row) {
          await env.DB.prepare("INSERT INTO balances (user_id,balance) VALUES (?,0)").bind(String(user_id)).run();
          row = { balance: 0 };
        }
        const nb = Number(row.balance) + amount;
        await env.DB.prepare("UPDATE balances SET balance=? WHERE user_id=?").bind(nb, String(user_id)).run();
        return json({ ok: true, balance: nb });
      }

      // ============ INVENTORY ============
      if (path === "/api/inventory" && request.method === "POST") {
        const { user_id } = await request.json();
        if (!user_id) return json({ error: "user_id required" }, 400);
        const { results } = await env.DB.prepare("SELECT * FROM inventory WHERE user_id=? ORDER BY id DESC").bind(String(user_id)).all();
        const items = (results || []).map(r => ({
          id: r.id, skinId: r.skin_id, name: r.name, weapon: r.weapon, rarity: r.rarity,
          wear: r.wear, wearName: r.wear_name, statTrak: !!r.stat_trak, price: Number(r.price) || 0,
        }));
        return json({ items });
      }

      if (path === "/api/inventory/add" && request.method === "POST") {
        const b = await request.json();
        const { user_id, skinId, name, weapon, rarity, wear, wearName, statTrak, price } = b;
        if (!user_id || !name) return json({ error: "bad payload" }, 400);

        const r = await env.DB.prepare(
          `INSERT INTO inventory (user_id, skin_id, name, weapon, rarity, wear, wear_name, stat_trak, price)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          String(user_id), String(skinId || ""), String(name),
          String(weapon || "rifle"), String(rarity || "consumer"),
          String(wear || "FN"), String(wearName || "Factory New"),
          statTrak ? 1 : 0, Number(price) || 0
        ).run();

        try {
          const best = await env.DB.prepare("SELECT price FROM best_drop WHERE user_id=?").bind(String(user_id)).first();
          if (!best || Number(price) > Number(best.price)) {
            await env.DB.prepare(
              `INSERT INTO best_drop (user_id, skin_id, name, weapon, rarity, wear, wear_name, stat_trak, price)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(user_id) DO UPDATE SET
                 skin_id=excluded.skin_id, name=excluded.name, weapon=excluded.weapon,
                 rarity=excluded.rarity, wear=excluded.wear, wear_name=excluded.wear_name,
                 stat_trak=excluded.stat_trak, price=excluded.price`
            ).bind(
              String(user_id), String(skinId || ""), String(name),
              String(weapon || "rifle"), String(rarity || "consumer"),
              String(wear || "FN"), String(wearName || "Factory New"),
              statTrak ? 1 : 0, Number(price) || 0
            ).run();
          }
        } catch (e) {}

        return json({ ok: true, id: r.meta.last_row_id });
      }

      if (path === "/api/inventory/remove" && request.method === "POST") {
        const { user_id, id } = await request.json();
        if (!user_id || !id) return json({ error: "bad payload" }, 400);
        await env.DB.prepare("DELETE FROM inventory WHERE id=? AND user_id=?").bind(Number(id), String(user_id)).run();
        return json({ ok: true });
      }

      if (path === "/api/inventory/sell" && request.method === "POST") {
        const { user_id, id } = await request.json();
        if (!user_id || !id) return json({ error: "bad payload" }, 400);
        const item = await env.DB.prepare("SELECT * FROM inventory WHERE id=? AND user_id=?").bind(Number(id), String(user_id)).first();
        if (!item) return json({ error: "not found" }, 404);
        await env.DB.prepare("DELETE FROM inventory WHERE id=? AND user_id=?").bind(Number(id), String(user_id)).run();

        let row = await env.DB.prepare("SELECT balance FROM balances WHERE user_id=?").bind(String(user_id)).first();
        if (!row) {
          await env.DB.prepare("INSERT INTO balances (user_id,balance) VALUES (?,0)").bind(String(user_id)).run();
          row = { balance: 0 };
        }
        const nb = Number(row.balance) + Number(item.price);
        await env.DB.prepare("UPDATE balances SET balance=? WHERE user_id=?").bind(nb, String(user_id)).run();
        return json({ ok: true, balance: nb, sold: Number(item.price) || 0 });
      }

      // ============ BEST DROP ============
      if (path === "/api/best_drop" && request.method === "POST") {
        const { user_id } = await request.json();
        if (!user_id) return json({ error: "bad payload" }, 400);
        const row = await env.DB.prepare("SELECT * FROM best_drop WHERE user_id=?").bind(String(user_id)).first();
        if (!row) return json({ best: null });
        return json({
          best: {
            skinId: row.skin_id, name: row.name, weapon: row.weapon, rarity: row.rarity,
            wear: row.wear, wearName: row.wear_name, statTrak: !!row.stat_trak,
            price: Number(row.price) || 0,
          }
        });
      }

      // ============ UPGRADE STATS ============
      if (path === "/api/upgrade_stats" && request.method === "POST") {
        const { user_id } = await request.json();
        if (!user_id) return json({ error: "bad payload" }, 400);
        let row = await env.DB.prepare("SELECT * FROM upgrade_stats WHERE user_id=?").bind(String(user_id)).first();
        if (!row) {
          await env.DB.prepare("INSERT INTO upgrade_stats (user_id,win_count,win_sum,lose_sum) VALUES (?,0,0,0)").bind(String(user_id)).run();
          row = { win_count: 0, win_sum: 0, lose_sum: 0 };
        }
        return json({
          win_count: Number(row.win_count) || 0,
          win_sum: Number(row.win_sum) || 0,
          lose_sum: Number(row.lose_sum) || 0,
        });
      }

      if (path === "/api/upgrade_stats/update" && request.method === "POST") {
        const { user_id, result, from_price, to_price } = await request.json();
        if (!user_id || !result) return json({ error: "bad payload" }, 400);

        let row = await env.DB.prepare("SELECT * FROM upgrade_stats WHERE user_id=?").bind(String(user_id)).first();
        if (!row) {
          await env.DB.prepare("INSERT INTO upgrade_stats (user_id,win_count,win_sum,lose_sum) VALUES (?,0,0,0)").bind(String(user_id)).run();
          row = { win_count: 0, win_sum: 0, lose_sum: 0 };
        }

        let winCount = Number(row.win_count) || 0;
        let winSum = Number(row.win_sum) || 0;
        let loseSum = Number(row.lose_sum) || 0;

        if (result === "win") {
          const diff = Math.max(0, Number(to_price) - Number(from_price));
          winCount += 1;
          winSum += diff;
        } else if (result === "lose") {
          loseSum += Number(from_price) || 0;
        }

        // Сброс, если проиграл больше, чем выиграл
        if (loseSum > winSum) {
          winCount = 0;
          winSum = 0;
          loseSum = 0;
        }

        await env.DB.prepare(
          "UPDATE upgrade_stats SET win_count=?, win_sum=?, lose_sum=? WHERE user_id=?"
        ).bind(winCount, winSum, loseSum, String(user_id)).run();

        return json({ win_count: winCount, win_sum: winSum, lose_sum: loseSum });
      }

      // ============ PROMOS ============
      if (path === "/api/promos" && request.method === "POST") {
        const { admin_token, code, stars, uses } = await request.json();
        if (admin_token !== ADMIN_TOKEN) return json({ error: "forbidden" }, 403);
        const c = String(code || "").trim().toUpperCase();
        if (!c) return json({ error: "code required" }, 400);

        await env.DB.prepare(
          `INSERT INTO promos (code, reward, uses, max_uses) VALUES (?, ?, 0, ?)
           ON CONFLICT(code) DO UPDATE SET reward=excluded.reward, max_uses=excluded.max_uses`
        ).bind(c, Number(stars) || 0, Number(uses) || 1).run();

        return json({ ok: true, code: c });
      }

      if (path === "/api/promo/apply" && request.method === "POST") {
        const { user_id, code } = await request.json();
        if (!user_id || !code) return json({ error: "bad payload" }, 400);
        const c = String(code).trim().toUpperCase();

        const promo = await env.DB.prepare("SELECT * FROM promos WHERE code=?").bind(c).first();
        if (!promo) return json({ ok: false, error: "not_found" });
        if (Number(promo.uses) >= Number(promo.max_uses)) return json({ ok: false, error: "exhausted" });

        const used = await env.DB.prepare("SELECT id FROM promo_uses WHERE code=? AND user_id=?").bind(c, String(user_id)).first();
        if (used) return json({ ok: false, error: "already_used" });

        await env.DB.prepare("INSERT INTO promo_uses (code, user_id) VALUES (?, ?)").bind(c, String(user_id)).run();
        await env.DB.prepare("UPDATE promos SET uses = uses + 1 WHERE code=?").bind(c).run();

        let row = await env.DB.prepare("SELECT balance FROM balances WHERE user_id=?").bind(String(user_id)).first();
        if (!row) {
          await env.DB.prepare("INSERT INTO balances (user_id,balance) VALUES (?,0)").bind(String(user_id)).run();
          row = { balance: 0 };
        }
        const nb = Number(row.balance) + Number(promo.reward);
        await env.DB.prepare("UPDATE balances SET balance=? WHERE user_id=?").bind(nb, String(user_id)).run();

        return json({ ok: true, reward: Number(promo.reward) || 0, balance: nb });
      }

      // ============ WITHDRAWALS ============
      if (path === "/api/withdrawals/create" && request.method === "POST") {
        const { user_id, inventory_id, steam_profile, trade_link } = await request.json();
        if (!user_id || !inventory_id) return json({ error: "bad payload" }, 400);
        if (!steam_profile || !trade_link) return json({ error: "steam_data_required" }, 400);

        const item = await env.DB.prepare("SELECT * FROM inventory WHERE id=? AND user_id=?").bind(Number(inventory_id), String(user_id)).first();
        if (!item) return json({ error: "item_not_found" }, 404);

        const pending = await env.DB.prepare("SELECT id FROM withdrawals WHERE inventory_id=? AND status='pending'").bind(Number(inventory_id)).first();
        if (pending) return json({ error: "already_pending" }, 400);

        const r = await env.DB.prepare(
          `INSERT INTO withdrawals
           (user_id, inventory_id, skin_name, skin_weapon, skin_rarity, skin_wear, skin_wear_name,
            skin_stat_trak, price, steam_profile, trade_link, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
        ).bind(
          String(user_id), Number(inventory_id), String(item.name),
          String(item.weapon || ""), String(item.rarity || ""),
          String(item.wear || ""), String(item.wear_name || ""),
          item.stat_trak ? 1 : 0, Number(item.price) || 0,
          String(steam_profile), String(trade_link)
        ).run();

        // Сразу удаляем из инвентаря
        await env.DB.prepare("DELETE FROM inventory WHERE id=? AND user_id=?").bind(Number(inventory_id), String(user_id)).run();

        return json({ ok: true, id: r.meta.last_row_id });
      }

      if (path === "/api/withdrawals" && request.method === "GET") {
        const { results } = await env.DB.prepare("SELECT * FROM withdrawals WHERE status='pending' ORDER BY id ASC").all();
        const rows = (results || []).map(r => ({
          id: r.id, user_id: r.user_id, inventory_id: r.inventory_id,
          skin_name: r.skin_name, skin_weapon: r.skin_weapon, skin_rarity: r.skin_rarity,
          skin_wear: r.skin_wear, skin_wear_name: r.skin_wear_name,
          skin_stat_trak: !!r.skin_stat_trak, price: Number(r.price) || 0,
          steam_profile: r.steam_profile, trade_link: r.trade_link,
          created_at: r.created_at,
        }));
        return json(rows);
      }

      if (path === "/api/withdrawals/action" && request.method === "POST") {
        const { admin_token, id, action } = await request.json();
        if (admin_token !== ADMIN_TOKEN) return json({ error: "forbidden" }, 403);
        if (!id || !action) return json({ error: "bad payload" }, 400);

        const wd = await env.DB.prepare("SELECT * FROM withdrawals WHERE id=?").bind(Number(id)).first();
        if (!wd) return json({ error: "not_found" }, 404);
        if (wd.status !== "pending") return json({ error: "already_processed" }, 400);

        if (action === "approve") {
          await env.DB.prepare("UPDATE withdrawals SET status='approved' WHERE id=?").bind(Number(id)).run();
        } else if (action === "reject") {
          await env.DB.prepare(
            `INSERT INTO inventory (user_id, skin_id, name, weapon, rarity, wear, wear_name, stat_trak, price)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            String(wd.user_id), "",
            String(wd.skin_name || ""),
            String(wd.skin_weapon || "rifle"),
            String(wd.skin_rarity || "consumer"),
            String(wd.skin_wear || "FN"),
            String(wd.skin_wear_name || "Factory New"),
            wd.skin_stat_trak ? 1 : 0,
            Number(wd.price) || 0
          ).run();
          await env.DB.prepare("UPDATE withdrawals SET status='rejected' WHERE id=?").bind(Number(id)).run();
        } else {
          return json({ error: "bad action" }, 400);
        }
        return json({ ok: true });
      }

      return json({ error: "not found", path }, 404);
    } catch (e) {
      return json({ error: String(e && e.message ? e.message : e) }, 500);
    }
  }
};
