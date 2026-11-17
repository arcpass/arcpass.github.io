const API = "/api/cabinet";
const NOTICES = {
    inactive: "Сейчас резервный сервер не активен. Обратитесь к администратору для его активации, затем повторите запрос.",
    unavailable: "Резервный сервер не подтвердил запрос. Повторите попытку позже.",
};

function endpoint(base, action) {
    const url = new URL(base);
    if (url.hostname !== "functions.yandexcloud.net") return base + action;
    url.searchParams.set("route", `reserve-${action.slice(1)}`);
    return url.href;
}

export async function chooseCabinet(primary, controller, send = fetch) {
    const healthy = async base => {
        try {
            const response = await send(endpoint(base, "/health"), {
                cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(3500),
            });
            return response.ok && (await response.json()).status === "ok";
        } catch {
            return false;
        }
    };
    const main = `${primary}${API}`;
    const reserve = new URL(controller).hostname === "functions.yandexcloud.net" ? controller : `${controller}/reserve-cabinet`;
    if (await healthy(main)) return main;
    return await healthy(reserve) ? reserve : null;
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
    const reserveLabel = reserveButton.textContent;
    const reserveFeedback = byId("reserve-notice");
    const date = new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" });
    const fmt = stamp => date.format(new Date(stamp * 1000));
    let backend, session, profile, refreshTimer;

    function notice(id, message) {
        const field = byId(id);
        field.textContent = message ?? "";
        field.hidden = !message;
    }

    function showAction(field, message = "", tone = "") {
        field.dataset.tone = tone;
        field.textContent = message;
    }

    async function api(path, { method = "GET", body } = {}) {
        const headers = { Accept: "application/json" };
        if (session) {
            const authorization = new URL(backend).hostname === "functions.yandexcloud.net"
                ? "X-ArcPass-Authorization" : "Authorization";
            headers[authorization] = `Bearer ${session}`;
        }
        try {
            const response = await fetch(endpoint(backend, path), {
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

    function render(data, requested = false) {
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
        if (requested || !reserveButton.disabled) {
            const warning = NOTICES[data.reserve_notice];
            if (warning) showAction(reserveFeedback, warning, "warning");
            else if (!requested) showAction(reserveFeedback);
            else if (link) showAction(reserveFeedback, "Запасная ссылка готова.", "success");
            else showAction(reserveFeedback, "Запасная ссылка пока недоступна.", "warning");
        }
        notice("cooldown", next ? `Следующий запрос доступен ${fmt(next)}.` : "");
        reserveButton.hidden = !!next;
        if (link) {
            byId("reserve-link").hidden = false;
            byId("reserve-config").value = link.config;
            byId("reserve-expires").textContent = fmt(link.expires_at);
        }
        byId("connection-guide").hidden = !(hasConfig || link);
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
            backend = await chooseCabinet(primary, controller);
            if (!backend) throw new CabinetError(0, "Кабинет временно недоступен. Повторите попытку.");
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
        reserveButton.setAttribute("aria-busy", "true");
        reserveButton.textContent = "Запрашиваем ссылку…";
        showAction(reserveFeedback, "Отправляем запрос на резервный сервер.");
        try {
            render(await api("/reserve", { method: "POST" }), true);
        } catch (error) {
            if (error.status === 401) {
                session = null;
                render(null);
                notice("feedback", error.message);
                accessCode.focus();
            } else {
                showAction(reserveFeedback, error.message, "warning");
            }
        } finally {
            reserveButton.disabled = false;
            reserveButton.removeAttribute("aria-busy");
            reserveButton.textContent = reserveLabel;
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
        const feedback = button.nextElementSibling;
        let reset;
        button.addEventListener("click", async () => {
            const field = byId(button.dataset.copy);
            if (!field.value) return;
            clearTimeout(reset);
            showAction(feedback);
            try {
                await navigator.clipboard.writeText(field.value);
                showAction(feedback, "Ссылка скопирована. Вставьте её в VPN-приложение по инструкции ниже.", "success");
                reset = setTimeout(() => showAction(feedback), 5000);
            } catch {
                field.closest("details").open = true;
                field.focus();
                field.select();
                showAction(feedback, "Ссылка выделена. Скопируйте её вручную.", "warning");
            }
        });
    }
    loginButton.disabled = false;
}

if (typeof document !== "undefined") start();
