"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleAllCommand = exports.handleToWordsCommand = exports.handleToJsonCommand = exports.handleTranslateCommand = exports.parseOptions = exports.allLanguages = void 0;
const ansi_colors_1 = require("ansi-colors");
const fs_extra_1 = require("fs-extra");
const os_1 = require("os");
const path_1 = __importDefault(require("path"));
const tiny_glob_1 = __importDefault(require("tiny-glob"));
const translate_1 = require("./translate");
const util_1 = require("./util");
let ioPackage;
let jsonConfig;
let admin;
let words;
let i18nBases;
let translateLanguages;
/********************************** Helpers ***********************************/
const _languages = {
    en: {},
    de: {},
    ru: {},
    pt: {},
    nl: {},
    fr: {},
    it: {},
    es: {},
    pl: {},
    "zh-cn": {},
};
exports.allLanguages = Object.keys(_languages);
function createEmptyLangObject(createDefault) {
    return translateLanguages.reduce((obj, curr) => ({ ...obj, [curr]: createDefault() }), {});
}
/**
 * Creates a regexp pattern for an english base file name.
 * It matches file names and allows to find/replace the language code
 */
function createFilePattern(baseFile) {
    if (!baseFile.match(/\Wen\W/)) {
        throw new Error("Base file must be an English JSON file");
    }
    return new RegExp(`^(${(0, util_1.escapeRegExp)(baseFile).replace(/(?<=\W)en(?=\W)/, ")([a-z-]+)(")})$`, "i");
}
async function findAllLanguageFiles(baseFile) {
    const filePattern = createFilePattern(baseFile);
    const allJsonFiles = await (0, tiny_glob_1.default)(path_1.default.join(admin, "**", "*.json").replace(/\\/g, "/"), {
        absolute: true,
    });
    return allJsonFiles.filter((file) => {
        const match = file.match(filePattern);
        if (!match) {
            return false;
        }
        const lang = match[2];
        return translateLanguages.includes(lang);
    });
}
/******************************** Middlewares *********************************/
async function parseOptions(options) {
    var _a;
    // io-package.json
    ioPackage = path_1.default.resolve(options["io-package"]);
    if (!(0, fs_extra_1.existsSync)(ioPackage) || !(await (0, fs_extra_1.stat)(ioPackage)).isFile()) {
        return (0, util_1.die)(`Couldn't find file ${ioPackage}`);
    }
    // jsonConfig.json
    jsonConfig = path_1.default.resolve(options.jsonConfig);
    if (!(0, fs_extra_1.existsSync)(jsonConfig) || !(await (0, fs_extra_1.stat)(jsonConfig)).isFile()) {
        jsonConfig = "N/A";
        console.log("  No jsonConfig file found. Skipping translation.");
    }
    // admin directory
    admin = path_1.default.resolve(options.admin);
    if (!(0, fs_extra_1.existsSync)(admin) || !(await (0, fs_extra_1.stat)(admin)).isDirectory()) {
        return (0, util_1.die)(`Couldn't find directory ${admin}`);
    }
    // words.js
    if (options.words) {
        words = path_1.default.resolve(options.words);
    }
    else if ((0, fs_extra_1.existsSync)(path_1.default.join(admin, "js", "words.js"))) {
        words = path_1.default.join(admin, "js", "words.js");
    }
    else {
        words = path_1.default.join(admin, "words.js");
    }
    // i18n base file
    if (options.base) {
        i18nBases = options.base.map((p) => path_1.default.resolve(p));
    }
    else {
        const defaultPath = path_1.default.join(admin, "i18n", "en", "translations.json");
        i18nBases = [
            defaultPath,
            path_1.default.join(admin, "src", "i18n", "en.json"),
        ].filter(fs_extra_1.existsSync);
        if (i18nBases.length === 0) {
            // if no path exists, we are most likely using words.js and
            // expect the i18n file to be in the default path
            i18nBases = [defaultPath];
        }
    }
    if ((_a = options.languages) === null || _a === void 0 ? void 0 : _a.length) {
        // Check if an unknown language was specified
        const unknownLanguages = options.languages.filter((l) => !exports.allLanguages.includes(l));
        if (unknownLanguages.length > 0) {
            return (0, util_1.die)(`Unknown language(s): ${unknownLanguages.join(", ")}`);
        }
        translateLanguages = options.languages;
    }
    else {
        translateLanguages = exports.allLanguages;
    }
}
exports.parseOptions = parseOptions;
/***************************** Command Handlers *******************************/
async function handleTranslateCommand() {
    await translateIoPackage();
    if ("N/A" !== jsonConfig)
        await translateJsonConfig();
    for (const i18nBase of i18nBases) {
        await translateI18n(i18nBase);
    }
}
exports.handleTranslateCommand = handleTranslateCommand;
function handleToJsonCommand() {
    if (!(0, fs_extra_1.existsSync)(words)) {
        return (0, util_1.die)(`Couldn't find words file ${words}`);
    }
    return adminWords2languages(words, i18nBases[0]);
}
exports.handleToJsonCommand = handleToJsonCommand;
function handleToWordsCommand() {
    return adminLanguages2words(i18nBases[0]);
}
exports.handleToWordsCommand = handleToWordsCommand;
async function handleAllCommand() {
    await handleTranslateCommand();
    await handleToWordsCommand();
    await handleToJsonCommand();
}
exports.handleAllCommand = handleAllCommand;
/****************************** Implementation ********************************/
async function translateIoPackage() {
    const content = await (0, fs_extra_1.readJson)(ioPackage);
    if (content.common.news) {
        console.log("Translate News");
        for (const [k, nw] of Object.entries(content.common.news)) {
            console.log(`News: ${k}`);
            await translateNotExisting(nw);
        }
    }
    if (content.common.titleLang) {
        console.log("Translate Title");
        await translateNotExisting(content.common.titleLang, content.common.title);
    }
    if (content.common.desc) {
        console.log("Translate Description");
        await translateNotExisting(content.common.desc);
    }
    // https://github.com/ioBroker/adapter-dev/issues/138
    if (content.common.messages) {
        console.log("Translate Messages");
        for (const message of content.common.messages) {
            console.log((0, ansi_colors_1.gray)(`   Message: ${message.title.en}`));
            await translateNotExisting(message.title);
            await translateNotExisting(message.text);
            // test first if there is a linkText - since it's not mandatory
            if (message.linkText)
                await translateNotExisting(message.linkText);
        }
    }
    await (0, fs_extra_1.writeJson)(ioPackage, content, { spaces: 4, EOL: os_1.EOL });
    console.log(`Successfully updated ${path_1.default.relative(".", ioPackage)}`);
}
async function loopJSON(content) {
    const baseContent = [];
    // read all existing language files
    for (let n = 0; n < i18nBases.length; n++) {
        if ((0, fs_extra_1.existsSync)(i18nBases[n])) {
            baseContent.push(await (0, fs_extra_1.readJson)(i18nBases[n]));
        }
    }
    // if there is no existing lang file create the default one
    if (baseContent.length === 0)
        baseContent[0] = await (0, fs_extra_1.readJson)("./admin/i18n/en/translations.json");
    let baseContentChanged = false;
    // iterate over the jsonConfig to find translatable entries
    for (const [key, value] of Object.entries(content)) {
        if (key === "i18n" && value === false) {
            console.log("Info: i18n-switch is set to false; No translation of jsonConfig needed; Exiting.");
            return content;
        }
        if (typeof value === "object") {
            if (value.en) {
                console.log((0, ansi_colors_1.gray)(`Translating: "${value.en}"`));
                await translateNotExisting(value);
                console.log((0, ansi_colors_1.yellow)(`Translated text object - but please consider changing it to: >"${key}": "${value.en}"< to be compliant with WebLate translation.`));
            }
            else {
                if (value.title || value.tooltip || value.label || value.text) {
                    const logText = value.title ||
                        value.tooltip ||
                        value.label ||
                        value.text;
                    if (typeof logText === "string") {
                        for (let n = 0; n < baseContent.length; n++) {
                            // @ts-ignore
                            if (!baseContent[n][logText]) {
                                baseContentChanged = true;
                                // @ts-ignore
                                baseContent[n][logText] = logText;
                                console.log((0, ansi_colors_1.gray)(`Added (${logText}) to english language file to get translated in the next step.`));
                            }
                        }
                    }
                }
            }
            await loopJSON(value);
        }
    }
    if (baseContentChanged) {
        for (let n = 0; n < baseContent.length; n++) {
            await (0, fs_extra_1.writeJson)(i18nBases[n], baseContent[n], { spaces: 4, EOL: os_1.EOL });
            console.log(`Successfully updated english base file (${i18nBases[n]}).`);
        }
    }
    return content;
}
async function translateJsonConfig() {
    // labels and titles may have language objects
    const content = await (0, fs_extra_1.readJson)(jsonConfig);
    if (content) {
        console.log("Translate jsonConfig");
        const result = await loopJSON(content);
        await (0, fs_extra_1.writeJson)(jsonConfig, result, { spaces: 4, EOL: os_1.EOL });
        console.log(`Successfully updated ${path_1.default.relative(".", jsonConfig)}`);
    }
}
async function translateNotExisting(obj, baseText) {
    const text = obj.en || baseText;
    if (text) {
        for (const lang of translateLanguages) {
            if (!obj[lang]) {
                const time = new Date().getTime();
                obj[lang] = await (0, translate_1.translateText)(text, lang);
                console.log((0, ansi_colors_1.gray)(`en -> ${lang} ${new Date().getTime() - time} ms`));
            }
        }
    }
}
async function translateI18n(baseFile) {
    const filePattern = createFilePattern(baseFile);
    const baseContent = await (0, fs_extra_1.readJson)(baseFile);
    const missingLanguages = new Set(translateLanguages);
    const files = await findAllLanguageFiles(baseFile);
    for (const file of files) {
        const match = file.match(filePattern);
        if (!match)
            continue;
        const lang = match[2];
        missingLanguages.delete(lang);
        if (lang === "en")
            continue;
        const translation = await (0, fs_extra_1.readJson)(file);
        await translateI18nJson(translation, lang, baseContent);
        await (0, fs_extra_1.writeJson)(file, translation, { spaces: 4, EOL: os_1.EOL });
        console.log(`Successfully updated ${path_1.default.relative(".", file)}`);
    }
    for (const lang of missingLanguages) {
        const translation = {};
        await translateI18nJson(translation, lang, baseContent);
        const filename = baseFile.replace(filePattern, `$1${lang}$3`);
        await (0, fs_extra_1.ensureDir)(path_1.default.dirname(filename));
        await (0, fs_extra_1.writeJson)(filename, translation, {
            spaces: 4,
            EOL: os_1.EOL,
        });
        console.log(`Successfully created ${path_1.default.relative(".", filename)}`);
    }
}
async function translateI18nJson(content, lang, baseContent) {
    if (lang === "en") {
        return;
    }
    const time = new Date().getTime();
    for (const [t, base] of Object.entries(baseContent)) {
        if (!content[t]) {
            content[t] = await (0, translate_1.translateText)(base, lang);
        }
    }
    console.log((0, ansi_colors_1.gray)(`Translate Admin en -> ${lang} ${new Date().getTime() - time} ms`));
}
async function adminWords2languages(words, i18nBase) {
    const filePattern = createFilePattern(i18nBase);
    const data = parseWordJs(await (0, fs_extra_1.readFile)(words, "utf-8"));
    const langs = createEmptyLangObject(() => ({}));
    for (const [word, translations] of Object.entries(data)) {
        for (const [lang, translation] of Object.entries(translations)) {
            const language = lang;
            langs[language][word] = translation;
            //  pre-fill all other languages
            for (const j of translateLanguages) {
                if (langs.hasOwnProperty(j)) {
                    langs[j][word] = langs[j][word] || "";
                }
            }
        }
    }
    for (const [lang, translations] of Object.entries(langs)) {
        const language = lang;
        const keys = Object.keys(translations);
        keys.sort();
        const obj = {};
        for (const key of keys) {
            obj[key] = langs[language][key];
        }
        const filename = i18nBase.replace(filePattern, `$1${lang}$3`);
        await (0, fs_extra_1.ensureDir)(path_1.default.dirname(filename));
        await (0, fs_extra_1.writeJson)(filename, obj, {
            spaces: 4,
            EOL: os_1.EOL,
        });
        console.log(`Successfully updated ${path_1.default.relative(".", filename)}`);
    }
}
function parseWordJs(words) {
    words = words.substring(words.indexOf("{"), words.length);
    words = words.substring(0, words.lastIndexOf(";"));
    const resultFunc = new Function("return " + words + ";");
    return resultFunc();
}
async function adminLanguages2words(i18nBase) {
    const filePattern = createFilePattern(i18nBase);
    const newWords = {};
    const files = await findAllLanguageFiles(i18nBase);
    for (const file of files) {
        const match = file.match(filePattern);
        if (!match)
            continue;
        const lang = match[2];
        const translations = await (0, fs_extra_1.readJson)(file);
        for (const key of Object.keys(translations)) {
            newWords[key] = newWords[key] || createEmptyLangObject(() => "");
            newWords[key][lang] = translations[key];
        }
    }
    try {
        // merge existing and new words together (and check for missing translations)
        const existingWords = parseWordJs(await (0, fs_extra_1.readFile)(words, "utf-8"));
        for (const [key, translations] of Object.entries(existingWords)) {
            if (!newWords[key]) {
                console.warn((0, ansi_colors_1.yellow)(`Take from current words.js: ${key}`));
                newWords[key] = translations;
            }
            translateLanguages
                .filter((lang) => !newWords[key][lang])
                .forEach((lang) => console.warn((0, ansi_colors_1.yellow)(`Missing "${lang}": ${key}`)));
        }
    }
    catch (error) {
        // ignore error, we just use the strings from the translation files
        //console.log(error);
    }
    await (0, fs_extra_1.writeFile)(words, createWordsJs(newWords));
    console.log(`Successfully updated ${path_1.default.relative(".", words)}`);
}
function createWordsJs(data) {
    const lines = [];
    lines.push("/*global systemDictionary:true */");
    lines.push("/*");
    lines.push("+===================== DO NOT MODIFY ======================+");
    lines.push("| This file was generated by translate-adapter, please use |");
    lines.push("| `translate-adapter adminLanguages2words` to update it.   |");
    lines.push("+===================== DO NOT MODIFY ======================+");
    lines.push("*/");
    lines.push("'use strict';\n");
    lines.push("systemDictionary = {");
    for (const [word, translations] of Object.entries(data)) {
        let line = "";
        for (const [lang, item] of Object.entries(translations)) {
            const text = (0, util_1.padRight)(item.replace(/"/g, '\\"') + '",', 50);
            line += `"${lang}": "${text} `;
        }
        if (line) {
            line = line.trim();
            line = line.substring(0, line.length - 1);
        }
        const preamble = (0, util_1.padRight)(`"${word.replace(/"/g, '\\"')}": {`, 50);
        lines.push(`    ${preamble}${line}},`);
    }
    lines.push("};");
    return lines.join(os_1.EOL).trimEnd();
}
//# sourceMappingURL=translate-adapter-handlers.js.map