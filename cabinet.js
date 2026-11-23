const API = "/api/cabinet";
// Embedded iOS browsers do not all support AbortSignal.timeout.
export async function cabinetFetch(url, options = {}, send = fetch, timeout = 25000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try { return await send(url, { ...options, signal: controller.signal }); }
    finally { clearTimeout(timer); }
}
export async function chooseCabinet(primary, send = fetch) {
    const healthy = async base => {
        try {
            const response = await cabinetFetch(base + "/health", {
                cache: "no-store", credentials: "omit", redirect: "error",
            }, send, 12000);
            return response.ok && (await response.json()).status === "ok";
        } catch {
            return false;
        }
    };
    const main = `${primary}${API}`;
    return await healthy(main) ? main : null;
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
    const loginForm = byId("login-form");
    const loginButton = loginForm.querySelector("button");
    const accessCode = byId("access-code");
    const reportButton = byId("report-problem");
    const reportLabel = reportButton.textContent;
    const reportFeedback = byId("problem-notice");
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
            headers.Authorization = `Bearer ${session}`;
        }
        try {
            const response = await cabinetFetch(backend + path, {
                method, body, headers, cache: "no-store", credentials: "omit", redirect: "error",
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
        const resetMethods = !data || !profile || profile.subscription !== data.subscription;
        profile = data;
        if (resetMethods) byId("ordinary-connection").open = !!data?.config && !data?.subscription;
        for (const feedback of document.querySelectorAll("[data-copy] + .action-feedback")) showAction(feedback);
        loginForm.hidden = !!data;
        byId("account").hidden = !data;
        byId("logout").hidden = !data;
        byId("config").value = data?.config ?? "";
        if (byId("subscription")) byId("subscription").value = data?.subscription ?? "";
        if (byId("subscription-block")) byId("subscription-block").hidden = !data?.subscription;
        byId("problem-report").hidden = !data;
        byId("connection-guide").hidden = true;
        if (!data) { showAction(reportFeedback); notice("problem-cooldown", ""); return; }

        const hasConfig = !!data.config;
        const timestamp = Date.now() / 1000;
        const next = data.problem_report?.next_at > timestamp ? data.problem_report.next_at : null;
        byId("deadline").textContent = data.deadline;
        byId("primary-config").hidden = !hasConfig;
        byId("config-missing").hidden = hasConfig;
        notice("updated", hasConfig && data.config_at ? `Обновлено ${fmt(data.config_at)}` : "");
        notice("problem-cooldown", next ? `Следующее сообщение можно отправить ${fmt(next)}.` : "");
        reportButton.disabled = !!next;
        byId("connection-guide").hidden = !hasConfig;
        for (const details of document.querySelectorAll("[data-platform]")) {
            details.hidden = data.platform !== "any" && data.platform !== details.dataset.platform;
        }
        if (next) refreshTimer = setTimeout(() => render(profile), Math.max(0, next * 1000 - Date.now()));
    }

    loginForm.addEventListener("submit", async event => {
        event.preventDefault();
        if (loginButton.disabled) return;
        const code = accessCode.value;
        loginButton.disabled = true;
        notice("feedback", "Подключаемся к кабинету…");
        try {
            // Login is the availability check; a separate short health timeout
            // must not prevent login on a resumed mobile connection.
            backend = `${primary}${API}`;
            ({ session } = await api("/login", { method: "POST", body: new URLSearchParams({ password: code }) }));
            let account;
            try { account = await api("/account"); }
            catch (error) {
                if (error.status !== 0) throw error;
                // Repeat only this read, never replay a mutation automatically.
                account = await api("/account");
            }
            accessCode.value = "";
            render(account);
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

    reportButton.addEventListener("click", async () => {
        if (reportButton.disabled) return;
        reportButton.disabled = true;
        reportButton.setAttribute("aria-busy", "true");
        reportButton.textContent = "Отправляем сообщение…";
        showAction(reportFeedback, "Сохраняем обращение администратору.");
        try {
            const result = await api("/report-problem", { method: "POST" });
            profile.problem_report = result;
            render(profile);
            showAction(reportFeedback, result.accepted
                ? "Сообщение сохранено и будет отправлено администратору."
                : "Вы уже сообщили о проблеме. Повторное сообщение будет доступно через несколько минут.", "success");
        } catch (error) {
            if (error.status === 401) {
                session = null;
                render(null);
                notice("feedback", error.message);
                accessCode.focus();
            } else {
                showAction(reportFeedback, error.message, "warning");
            }
        } finally {
            reportButton.disabled = !!profile?.problem_report?.next_at && profile.problem_report.next_at > Date.now() / 1000;
            reportButton.removeAttribute("aria-busy");
            reportButton.textContent = reportLabel;
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
                const message = button.dataset.copy === "subscription"
                    ? "Подписка скопирована. Добавьте её по URL по инструкции в этом блоке."
                    : "Прямая ссылка скопирована. Импортируйте её из буфера обмена по инструкции в этом блоке.";
                showAction(feedback, message, "success");
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
