const API = "/api/cabinet";
const NOTICES = {
    inactive: "Сейчас резервный сервер не активен. Обратитесь к администратору для его активации, затем повторите запрос.",
    unavailable: "Резервный сервер не подтвердил запрос. Повторите попытку позже.",
};

export function readyReserve(state, timestamp = Date.now()) {
    if (state?.status !== "ready" || !Number.isSafeInteger(state.until) || state.until <= timestamp
        || typeof state.url !== "string") return null;
    try {
        const target = new URL(state.url);
        if (state.url !== `${target.origin}/` || target.protocol !== "https:" || target.port
            || !/^\d+\.\d+\.\d+\.\d+$/.test(target.hostname)) return null;
        const [a, b] = target.hostname.split(".").map(Number);
        if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
            || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return null;
        return target.origin;
    } catch {
        return null;
    }
}

export async function chooseCabinet(primary, controller, send = fetch) {
    const get = async (origin, path) => {
        if (!origin) return null;
        try {
            const response = await send(`${origin}${path}`, {
                cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(3500),
            });
            return response.ok ? await response.json() : null;
        } catch {
            return null;
        }
    };
    const reserveCheck = get(controller, "/status");
    if ((await get(primary, `${API}/health`))?.status === "ok") return primary;
    const reserve = readyReserve(await reserveCheck);
    return (await get(reserve, `${API}/health`))?.status === "ok" ? reserve : null;
}

class CabinetError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function start() {
    const byId = id => document.getElementById(id);
    const primary = document.querySelector('meta[name="cabinet-origin"]').content;
    const controller = document.querySelector('meta[name="emergency-origin"]').content;
    const loginForm = byId("login-form");
    const loginButton = loginForm.querySelector("button");
    const accessCode = byId("access-code");
    const reserveButton = byId("request-reserve");
    const date = new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" });
    const fmt = stamp => date.format(new Date(stamp * 1000));
    let origin, session, profile, refreshTimer;

    function notice(id, message) {
        const field = byId(id);
        field.textContent = message ?? "";
        field.hidden = !message;
    }

    async function api(path, { method = "GET", body } = {}) {
        const headers = { Accept: "application/json" };
        if (session) headers.Authorization = `Bearer ${session}`;
        try {
            const response = await fetch(`${origin}${API}${path}`, {
                method, body, headers, cache: "no-store", credentials: "omit", redirect: "error",
                signal: AbortSignal.timeout(25000),
            });
            const data = await response.json();
            if (!response.ok) throw new CabinetError(response.status, data.error ?? "Не удалось выполнить запрос.");
            return data;
        } catch (error) {
            if (error instanceof CabinetError) throw error;
            throw new CabinetError(0, "Кабинет временно недоступен. Повторите попытку.");
        }
    }

    function render(data) {
        clearTimeout(refreshTimer);
        profile = data;
        loginForm.hidden = !!data;
        byId("account").hidden = !data;
        byId("logout").hidden = !data;
        byId("config").value = data?.config ?? "";
        byId("reserve-config").value = "";
        byId("reserve").hidden = !data?.reserve_enabled;
        byId("reserve-link").hidden = true;
        byId("connection-guide").hidden = true;
        if (!data) return;

        const hasConfig = !!data.config;
        const temporary = data.temporary && data.reserve_enabled;
        const timestamp = Date.now() / 1000;
        const link = data.reserve?.expires_at > timestamp ? data.reserve : null;
        const next = data.next_at > timestamp ? data.next_at : null;
        byId("deadline").textContent = data.deadline;
        byId("primary-config").hidden = !hasConfig;
        byId("config-missing").hidden = hasConfig || temporary;
        byId("temporary").hidden = !temporary;
        notice("updated", hasConfig && data.config_at ? `Обновлено ${fmt(data.config_at)}` : "");
        notice("reserve-notice", NOTICES[data.reserve_notice]);
        notice("cooldown", next ? `Следующий запрос доступен ${fmt(next)}.` : "");
        reserveButton.hidden = !!next;
        if (link) {
            byId("reserve-link").hidden = false;
            byId("reserve-config").value = link.config;
            byId("reserve-expires").textContent = fmt(link.expires_at);
        }
        byId("connection-guide").hidden = !(hasConfig || link);
        byId("guide-copy").dataset.copy = hasConfig ? "config" : "reserve-config";
        for (const details of document.querySelectorAll("[data-platform]")) {
            details.hidden = data.platform !== "any" && data.platform !== details.dataset.platform;
        }
        if (link || next) {
            const wake = Math.min(link?.expires_at ?? Infinity, next ?? Infinity);
            refreshTimer = setTimeout(() => render(profile), Math.max(0, wake * 1000 - Date.now()));
        }
    }

    loginForm.addEventListener("submit", async event => {
        event.preventDefault();
        if (loginButton.disabled) return;
        const code = accessCode.value;
        accessCode.value = "";
        loginButton.disabled = true;
        notice("feedback", "Подключаемся к кабинету…");
        try {
            origin = await chooseCabinet(primary, controller);
            if (!origin) throw new CabinetError(0, "Кабинет временно недоступен. Повторите попытку.");
            ({ session } = await api("/login", { method: "POST", body: new URLSearchParams({ password: code }) }));
            render(await api("/account"));
            notice("feedback", "");
        } catch (error) {
            session = null;
            render(null);
            notice("feedback", error.message);
            accessCode.focus();
        } finally {
            loginButton.disabled = false;
        }
    });

    reserveButton.addEventListener("click", async () => {
        reserveButton.disabled = true;
        try {
            render(await api("/reserve", { method: "POST" }));
            notice("feedback", "");
        } catch (error) {
            if ([0, 401, 503].includes(error.status)) {
                session = null;
                render(null);
            }
            notice("feedback", error.message);
        } finally {
            reserveButton.disabled = false;
        }
    });

    byId("logout").addEventListener("click", async event => {
        const button = event.currentTarget;
        button.disabled = true;
        try { await api("/logout", { method: "POST" }); } catch { /* Clear the local session when the backend is offline. */ }
        finally {
            session = null;
            render(null);
            notice("feedback", "");
            button.disabled = false;
            accessCode.focus();
        }
    });

    for (const button of document.querySelectorAll("[data-copy]")) {
        button.addEventListener("click", async () => {
            const field = byId(button.dataset.copy);
            if (!field.value) return;
            try {
                await navigator.clipboard.writeText(field.value);
                notice("feedback", "Ссылка скопирована.");
            } catch {
                field.focus();
                field.select();
                notice("feedback", "Ссылка выделена. Скопируйте её вручную.");
            }
        });
    }
    loginButton.disabled = false;
}

if (typeof document !== "undefined") start();
