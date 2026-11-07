(() => {
  "use strict";
  const config = window.APP_CONFIG || {};
  const form = document.querySelector("#application-form");
  const submit = document.querySelector("#submit-button");
  const error = document.querySelector("#form-error");
  const notice = document.querySelector("#availability");
  const body = document.querySelector("#body");
  let busy = false;
  let request = null;
  const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co\/functions\/v1\/create-application$/.test(config.endpoint || "")
    && /^[a-zA-Z0-9_]{5,32}$/.test(config.botUsername || "");
  if (!configured) { submit.disabled = true; notice.hidden = false; }
  body.addEventListener("input", () => { document.querySelector("#counter").textContent = body.value.length + " / 2000"; });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !configured || !form.reportValidity()) return;
    const data = Object.fromEntries(new FormData(form));
    const payload = { name: data.name.trim(), subject: data.subject.trim(), body: data.body.trim(), website: data.website };
    if (!payload.name || !payload.subject || payload.body.length < 5) {
      error.textContent = "Пожалуйста, заполните имя, тему и описание (не менее 5 символов)."; error.hidden = false; return;
    }
    const fingerprint = JSON.stringify(payload);
    if (!request || request.fingerprint !== fingerprint) request = { key: crypto.randomUUID(), fingerprint };
    busy = true; submit.disabled = true; submit.firstElementChild.textContent = "Сохраняем обращение…"; error.hidden = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(config.endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, requestKey: request.key }), signal: controller.signal, credentials: "omit" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 410) request = null;
        throw new Error(result.error || "Не удалось сохранить обращение. Попробуйте ещё раз.");
      }
      const url = new URL(result.telegramUrl);
      if (url.protocol !== "https:" || url.hostname !== "t.me" || url.pathname !== "/" + config.botUsername
        || !/^[A-Za-z0-9_-]{1,64}$/.test(url.searchParams.get("start") || "")) throw new Error("Не удалось получить ссылку подтверждения. Попробуйте позже.");
      document.querySelector("#telegram-link").href = url.href;
      document.querySelector("#form-panel").hidden = true;
      const panel = document.querySelector("#confirmation-panel"); panel.hidden = false; panel.focus();
    } catch (e) {
      error.textContent = e.name === "AbortError" ? "Ответ сервиса задерживается. Ваш текст сохранён в форме. Нажмите ещё раз, дубль не создастся." :
        e instanceof TypeError ? "Нет связи с сервисом. Проверьте интернет и попробуйте ещё раз." : e.message;
      error.hidden = false;
    } finally {
      clearTimeout(timeout); busy = false; submit.disabled = false; submit.firstElementChild.textContent = "Продолжить в Telegram";
    }
  });
  document.querySelector("#back-button").addEventListener("click", () => {
    document.querySelector("#confirmation-panel").hidden = true; document.querySelector("#form-panel").hidden = false;
    document.querySelector("#name").focus();
  });
})();

