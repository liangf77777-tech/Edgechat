import type { Hono } from "hono";
import {
  isUserActiveById,
  listContacts,
  searchContactsByUsername,
  setContactAlias,
} from "../data/users.js";
import { errorResponse, parseJsonRequest } from "../utils.js";

export function registerContactRoutes(app: Hono) {
  app.get("/api/contacts", async (c) => {
    const session = c.get("session");
    const users = await listContacts(c.env.DB, session.userId);
    return c.json({ users });
  });

  // 按用户名添加好友：精确匹配优先，其次前缀匹配，最多返回 8 条。
  // 只查活跃、未删除、非本人的用户，避免全站用户名被枚举。
  app.get("/api/contacts/search", async (c) => {
    const session = c.get("session");
    const q = String(c.req.query("q") || "").trim();
    if (!q) {
      return c.json({ users: [] });
    }
    const users = await searchContactsByUsername(c.env.DB, {
      query: q,
      excludeUserId: session.userId,
      limit: 8,
    });
    return c.json({ users });
  });

  // 修改好友备注：只写当前用户自己的视角，传空字符串即可清除备注。
  app.put("/api/contacts/:id/alias", async (c) => {
    const session = c.get("session");
    const contactId = Number(c.req.param("id"));
    if (
      !Number.isInteger(contactId) ||
      contactId <= 0 ||
      contactId === Number(session.userId)
    ) {
      return errorResponse("无效的好友");
    }
    if (!(await isUserActiveById(c.env.DB, contactId))) {
      return errorResponse("好友不存在", 404);
    }
    const payload = await parseJsonRequest(c.req.raw);
    const alias = await setContactAlias(
      c.env.DB,
      session.userId,
      contactId,
      payload.alias ?? "",
    );
    return c.json({ ok: true, alias });
  });
}
