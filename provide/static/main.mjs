async function compressString(str) {
    const stream = new ReadableStream({
        start(c) {
            c.enqueue(new TextEncoder().encode(str));
            c.close();
        },
    }).pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decompressString(compressedData) {
    const stream = new ReadableStream({
        start(c) {
            c.enqueue(compressedData);
            c.close();
        },
    }).pipeThrough(new DecompressionStream("deflate"));
    return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

// 原生 Uint8Array base64 还是新特性，旧浏览器不支持时才动态加载兜底
const hasNativeBase64 = typeof Uint8Array.fromBase64 === "function" &&
    typeof Uint8Array.prototype.toBase64 === "function";

let jsBase64Promise = null;
function loadJsBase64() {
    if (!jsBase64Promise) {
        jsBase64Promise = import("https://cdn.jsdelivr.net/npm/js-base64@3.9.4/+esm").then(
            (mod) => mod.Base64 ?? mod.default?.Base64 ?? mod.default ?? mod,
        );
    }
    return jsBase64Promise;
}

async function decodeBase64Url(value) {
    if (hasNativeBase64) {
        return Uint8Array.fromBase64(value, { alphabet: "base64url" });
    }
    const Base64 = await loadJsBase64();
    return Base64.toUint8Array(value);
}

async function encodeBase64Url(value) {
    if (hasNativeBase64) {
        return value.toBase64({ alphabet: "base64url", omitPadding: true });
    }
    const Base64 = await loadJsBase64();
    return Base64.fromUint8Array(value, true);
}

const CONFIG_TEMPLATES = {
    0: { configurl: "config.json.template", outFields: "1" },
    1: { configurl: "config.json-1.11.0+.template", outFields: "0" },
    4: { configurl: "config.json-1.12.0+.template", outFields: "0" },
    5: { configurl: "config.json-1.14.0+.template", outFields: "0" },
};

class Clash2SfaApp extends HTMLElement {
    oldConfig = "";
    abortController = null;

    connectedCallback() {
        if (this.initialized) return;
        this.initialized = true;

        this.sub = this.querySelector('[data-ref="sub"]');
        this.include = this.querySelector('[data-ref="include"]');
        this.exclude = this.querySelector('[data-ref="exclude"]');
        this.ua = this.querySelector('[data-ref="ua"]');
        this.config = this.querySelector('[data-ref="config"]');
        this.configurl = this.querySelector('[data-ref="config-url"]');
        this.configType = this.querySelector('[data-ref="config-type"]');
        this.disableUrlTest = this.querySelector('[data-ref="disable-url-test"]');
        this.addTag = this.querySelector('[data-ref="add-tag"]');
        this.outFields = this.querySelector('[data-ref="out-fields"]');
        this.fetchProgress = this.querySelector('[data-ref="in-fetch"]');
        this.newSub = this.querySelector('[data-ref="new-sub"]');
        this.convert = this.querySelector('[data-ref="convert"]');
        this.sourceFile = this.querySelector('[data-ref="source-file"]');
        this.sourceContent = this.querySelector('[data-ref="source-content"]');
        this.convertContent = this.querySelector('[data-ref="convert-content"]');
        this.contentProgress = this.querySelector('[data-ref="content-progress"]');
        this.convertResult = this.querySelector('[data-ref="convert-result"]');
        this.resultLabel = this.querySelector('[data-ref="result-label"]');
        this.downloadResult = this.querySelector('[data-ref="download-result"]');
        this.resultObjectURL = null;

        this.abortController = new AbortController();
        const { signal } = this.abortController;
        this.convert.addEventListener("click", this.handleClick, { signal });
        this.convertContent.addEventListener("click", this.handleContentConvert, { signal });
        this.sourceFile.addEventListener("change", this.handleFileChange, { signal });
        this.downloadResult.addEventListener("click", this.handleDownload, { signal });
        this.configType.addEventListener("change", this.onConfigTypeChange, { signal });
        document.addEventListener("paste", this.handlePaste, { signal });

        this.updateConfigVisibility();
        this.loadDefaultConfig();
    }

    disconnectedCallback() {
        if (!this.initialized) return;
        this.abortController?.abort();
        this.abortController = null;
        if (this.resultObjectURL) URL.revokeObjectURL(this.resultObjectURL);
        this.initialized = false;
    }

    async loadDefaultConfig() {
        try {
            const version = document.querySelector('meta[name="app-version"]')?.content ?? "";
            const response = await fetch("/config/config.json-1.14.0+.template?" + version);
            this.config.value = await response.text();
            this.oldConfig = this.config.value;
        } catch (error) {
            this.config.value = "";
            console.warn(error);
        }
    }

    updateConfigVisibility() {
        this.config.hidden = this.configType.value !== "2";
        this.configurl.hidden = this.configType.value !== "3";
    }

    setFetching(value) {
        this.fetchProgress.hidden = !value;
        this.convert.hidden = value;
    }

    async saveParameter() {
        const subUrl = new URL(location.origin);
        subUrl.pathname = "/sub";
        const config = this.config.value !== this.oldConfig ? this.config.value : "";
        if (config !== "") {
            subUrl.searchParams.set("config", await encodeBase64Url(await compressString(config)));
        }
        if (this.configurl.value) subUrl.searchParams.set("configurl", this.configurl.value);
        if (this.include.value) subUrl.searchParams.set("include", this.include.value);
        if (this.exclude.value) subUrl.searchParams.set("exclude", this.exclude.value);
        if (this.ua.value.trim()) subUrl.searchParams.set("ua", this.ua.value.trim());
        if (this.addTag.checked) subUrl.searchParams.set("addTag", "true");
        if (this.disableUrlTest.checked) subUrl.searchParams.set("disableUrlTest", "true");
        if (this.outFields.value) subUrl.searchParams.set("outFields", this.outFields.value);
        subUrl.searchParams.set("sub", this.sub.value.trim());
        return subUrl.toString();
    }

    handleClick = async () => {
        if (this.sub.value.trim() === "" || !this.fetchProgress.hidden) return "";
        this.newSub.value = "";
        this.newSub.hidden = true;
        this.setFetching(true);
        try {
            const subURL = await this.saveParameter();
            const response = await fetch(subURL);
            if (!response.ok) {
                const message = await response.text();
                this.newSub.value = message;
                this.newSub.hidden = false;
                console.warn(message);
                alert("错误 " + message);
                return;
            }
            this.newSub.value = subURL;
            this.newSub.hidden = false;
            this.newSub.scrollIntoView({ behavior: "smooth" });
            this.newSub.select();
            try {
                await navigator.clipboard.writeText(subURL);
            } catch (error) {
                console.warn(error);
            }
            const sing = new URL("sing-box://import-remote-profile");
            sing.searchParams.set("url", subURL);
            window.location.href = sing.toString();
        } catch (error) {
            console.warn(error);
            alert(String(error));
        } finally {
            this.setFetching(false);
        }
    };

    handleFileChange = async () => {
        const file = this.sourceFile.files?.[0];
        if (!file) return;
        if (file.size > 10 * 1000 * 1000) {
            alert("配置文件不能超过 10 MB");
            this.sourceFile.value = "";
            return;
        }
        this.sourceContent.value = await file.text();
    };

    handleContentConvert = async () => {
        const content = this.sourceContent.value.trim();
        if (!content || !this.contentProgress.hidden) return;
        this.convertContent.hidden = true;
        this.contentProgress.hidden = false;
        this.convertResult.hidden = true;
        this.resultLabel.hidden = true;
        this.downloadResult.hidden = true;
        try {
            const url = new URL(await this.saveParameter());
            url.pathname = "/convert";
            url.searchParams.delete("sub");
            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "text/yaml; charset=utf-8" },
                body: content,
            });
            const result = await response.text();
            if (!response.ok) throw new Error(result || `HTTP ${response.status}`);
            this.convertResult.value = result;
            this.convertResult.hidden = false;
            this.resultLabel.hidden = false;
            this.downloadResult.hidden = false;
            this.convertResult.scrollIntoView({ behavior: "smooth", block: "start" });
        } catch (error) {
            alert("转换失败：" + String(error));
        } finally {
            this.convertContent.hidden = false;
            this.contentProgress.hidden = true;
        }
    };

    handleDownload = () => {
        if (this.resultObjectURL) URL.revokeObjectURL(this.resultObjectURL);
        this.resultObjectURL = URL.createObjectURL(new Blob([this.convertResult.value], { type: "application/json" }));
        const link = document.createElement("a");
        link.href = this.resultObjectURL;
        link.download = "sing-box.json";
        link.click();
    };

    handlePaste = async (event) => {
        const text = event.clipboardData?.getData("text")?.trim();
        if (!text) return;
        let url;
        try {
            url = new URL(text);
        } catch {
            return;
        }
        if (url.pathname !== "/sub") return;
        if (!confirm("解析粘贴的订阅链接？")) return;
        try {
            const config = url.searchParams.get("config");
            if (config) {
                this.configType.value = "2";
                this.config.value = await decompressString(await decodeBase64Url(config));
            }
            const configurl = url.searchParams.get("configurl");
            if (configurl) {
                this.configurl.value = configurl;
                this.config.value = this.oldConfig;
                this.configType.value = "3";
            } else {
                this.configurl.value = "";
            }
            this.include.value = url.searchParams.get("include") || this.include.value;
            this.exclude.value = url.searchParams.get("exclude") || this.exclude.value;
            this.ua.value = url.searchParams.get("ua") || this.ua.value;
            this.sub.value = url.searchParams.get("sub") || this.sub.value;
            this.addTag.checked = url.searchParams.get("addTag") === "true";
            this.disableUrlTest.checked = url.searchParams.get("disableUrlTest") === "true";
            this.outFields.value = url.searchParams.get("outFields") || this.outFields.value;
            this.updateConfigVisibility();
        } catch (error) {
            console.log(error);
        }
    };

    onConfigTypeChange = () => {
        const { value } = this.configType;
        this.outFields.value = "";
        if (value !== "2") this.config.value = "";
        if (value !== "3") this.configurl.value = "";
        const preset = CONFIG_TEMPLATES[value];
        if (preset) {
            this.configurl.value = preset.configurl;
            this.outFields.value = preset.outFields;
        }
        if (value === "2" && this.config.value === "") this.config.value = this.oldConfig;
        this.updateConfigVisibility();
    };
}

customElements.define("clash2sfa-app", Clash2SfaApp);
