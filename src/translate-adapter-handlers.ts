import { gray, yellow } from "ansi-colors";
import {
	ensureDir,
	existsSync,
	readFile,
	readJson,
	stat,
	writeFile,
	writeJson,
} from "fs-extra";
import { EOL } from "os";
import path from "path";
import glob from "tiny-glob";
import { translateText } from "./translate";
import { die, escapeRegExp, padRight } from "./util";

let ioPackage: string;
let jsonConfig: string;
let admin: string;
let words: string;
let i18nBases: string[];
let translateLanguages: ioBroker.Languages[];

/********************************** Helpers ***********************************/

const _languages: Record<ioBroker.Languages, any> = {
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
export const allLanguages = Object.keys(_languages) as ioBroker.Languages[];

function createEmptyLangObject<T>(
	createDefault: () => T,
): Record<ioBroker.Languages, T> {
	return translateLanguages.reduce(
		(obj, curr) => ({ ...obj, [curr]: createDefault() }),
		{} as Record<ioBroker.Languages, T>,
	);
}

/**
 * Creates a regexp pattern for an english base file name.
 * It matches file names and allows to find/replace the language code
 */
function createFilePattern(baseFile: string): RegExp {
	if (!baseFile.match(/\Wen\W/)) {
		throw new Error("Base file must be an English JSON file");
	}
	return new RegExp(
		`^(${escapeRegExp(baseFile).replace(
			/(?<=\W)en(?=\W)/,
			")([a-z-]+)(",
		)})$`,
		"i",
	);
}

async function findAllLanguageFiles(baseFile: string): Promise<string[]> {
	const filePattern = createFilePattern(baseFile);
	const allJsonFiles = await glob(
		path.join(admin, "**", "*.json").replace(/\\/g, "/"),
		{
			absolute: true,
		},
	);

	return allJsonFiles.filter((file) => {
		const match = file.match(filePattern);
		if (!match) {
			return false;
		}
		const lang = match[2] as ioBroker.Languages;
		return translateLanguages.includes(lang);
	});
}

/******************************** Middlewares *********************************/

export async function parseOptions(options: {
	"io-package": string;
	jsonConfig: string;
	admin: string;
	words?: string;
	base?: string[];
	languages?: string[];
}): Promise<void> {
	// io-package.json
	ioPackage = path.resolve(options["io-package"]);
	if (!existsSync(ioPackage) || !(await stat(ioPackage)).isFile()) {
		return die(`Couldn't find file ${ioPackage}`);
	}

	// jsonConfig.json
	jsonConfig = path.resolve(options.jsonConfig);
	if (!existsSync(jsonConfig) || !(await stat(jsonConfig)).isFile()) {
		jsonConfig = "N/A";
		console.log("  No jsonConfig file found. Skipping translation.");
	}

	// admin directory
	admin = path.resolve(options.admin);
	if (!existsSync(admin) || !(await stat(admin)).isDirectory()) {
		return die(`Couldn't find directory ${admin}`);
	}

	// words.js
	if (options.words) {
		words = path.resolve(options.words);
	} else if (existsSync(path.join(admin, "js", "words.js"))) {
		words = path.join(admin, "js", "words.js");
	} else {
		words = path.join(admin, "words.js");
	}

	// i18n base file
	if (options.base) {
		i18nBases = options.base.map((p) => path.resolve(p));
	} else {
		const defaultPath = path.join(admin, "i18n", "en", "translations.json");
		i18nBases = [
			defaultPath,
			path.join(admin, "src", "i18n", "en.json"),
		].filter(existsSync);
		if (i18nBases.length === 0) {
			// if no path exists, we are most likely using words.js and
			// expect the i18n file to be in the default path
			i18nBases = [defaultPath];
		}
	}

	if (options.languages?.length) {
		// Check if an unknown language was specified
		const unknownLanguages = options.languages.filter(
			(l) => !allLanguages.includes(l as any),
		);
		if (unknownLanguages.length > 0) {
			return die(`Unknown language(s): ${unknownLanguages.join(", ")}`);
		}
		translateLanguages = options.languages as ioBroker.Languages[];
	} else {
		translateLanguages = allLanguages;
	}
}

/***************************** Command Handlers *******************************/

export async function handleTranslateCommand(): Promise<void> {
	await translateIoPackage();
	if ("N/A" !== jsonConfig) await translateJsonConfig();
	for (const i18nBase of i18nBases) {
		await translateI18n(i18nBase);
	}
}

export function handleToJsonCommand(): Promise<void> {
	if (!existsSync(words)) {
		return die(`Couldn't find words file ${words}`);
	}

	return adminWords2languages(words, i18nBases[0]);
}

export function handleToWordsCommand(): Promise<void> {
	return adminLanguages2words(i18nBases[0]);
}

export async function handleAllCommand(): Promise<void> {
	await handleTranslateCommand();
	await handleToWordsCommand();
	await handleToJsonCommand();
}

/****************************** Implementation ********************************/

async function translateIoPackage(): Promise<void> {
	const content = await readJson(ioPackage);
	if (content.common.news) {
		console.log("Translate News");
		for (const [k, nw] of Object.entries(content.common.news)) {
			console.log(`News: ${k}`);
			await translateNotExisting(nw as any);
		}
	}
	if (content.common.titleLang) {
		console.log("Translate Title");
		await translateNotExisting(
			content.common.titleLang,
			content.common.title,
		);
	}
	if (content.common.desc) {
		console.log("Translate Description");
		await translateNotExisting(content.common.desc);
	}
	// https://github.com/ioBroker/adapter-dev/issues/138
	if (content.common.messages) {
		console.log("Translate Messages");
		for (const message of content.common.messages) {
			console.log(gray(`   Message: ${message.title.en}`));
			await translateNotExisting(message.title);
			await translateNotExisting(message.text);
			// test first if there is a linkText - since it's not mandatory
			if (message.linkText) await translateNotExisting(message.linkText);
		}
	}
	await writeJson(ioPackage, content, { spaces: 4, EOL });
	console.log(`Successfully updated ${path.relative(".", ioPackage)}`);
}

async function loopJSON(content: object): Promise<object> {
	const baseContent: object[] = [];
	// read all existing language files
	for (let n = 0; n < i18nBases.length; n++) {
		if (existsSync(i18nBases[n])) {
			baseContent.push(await readJson(i18nBases[n]));
		}
	}
	// if there is no existing lang file create the default one
	if (baseContent.length === 0)
		baseContent[0] = await readJson("./admin/i18n/en/translations.json");
	let baseContentChanged = false;
	// iterate over the jsonConfig to find translatable entries
	for (const [key, value] of Object.entries(content)) {
		if (key === "i18n" && value === false) {
			console.log(
				"Info: i18n-switch is set to false; No translation of jsonConfig needed; Exiting.",
			);
			return content;
		}
		if (typeof value === "object") {
			if (value.en) {
				console.log(gray(`Translating: "${value.en}"`));
				await translateNotExisting(value);
				console.log(
					yellow(
						`Translated text object - but please consider changing it to: >"${key}": "${value.en}"< to be compliant with WebLate translation.`,
					),
				);
			} else {
				if (value.title || value.tooltip || value.label || value.text) {
					const logText =
						value.title ||
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
								console.log(
									gray(
										`Added (${logText}) to english language file to get translated in the next step.`,
									),
								);
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
			await writeJson(i18nBases[n], baseContent[n], { spaces: 4, EOL });
			console.log(
				`Successfully updated english base file (${i18nBases[n]}).`,
			);
		}
	}
	return content;
}

async function translateJsonConfig(): Promise<void> {
	// labels and titles may have language objects
	const content = await readJson(jsonConfig);
	if (content) {
		console.log("Translate jsonConfig");
		const result = await loopJSON(content);
		await writeJson(jsonConfig, result, { spaces: 4, EOL });
		console.log(`Successfully updated ${path.relative(".", jsonConfig)}`);
	}
}

async function translateNotExisting(
	obj: Partial<Record<ioBroker.Languages, string>>,
	baseText?: string,
): Promise<void> {
	const text = obj.en || baseText;

	if (text) {
		for (const lang of translateLanguages) {
			if (!obj[lang]) {
				const time = new Date().getTime();
				obj[lang] = await translateText(text, lang);
				console.log(
					gray(`en -> ${lang} ${new Date().getTime() - time} ms`),
				);
			}
		}
	}
}

async function translateI18n(baseFile: string): Promise<void> {
	const filePattern = createFilePattern(baseFile);
	const baseContent = await readJson(baseFile);
	const missingLanguages = new Set<ioBroker.Languages>(translateLanguages);
	const files = await findAllLanguageFiles(baseFile);
	for (const file of files) {
		const match = file.match(filePattern);
		if (!match) continue;
		const lang = match[2] as ioBroker.Languages;
		missingLanguages.delete(lang);
		if (lang === "en") continue;
		const translation = await readJson(file);
		await translateI18nJson(translation, lang, baseContent);
		await writeJson(file, translation, { spaces: 4, EOL });
		console.log(`Successfully updated ${path.relative(".", file)}`);
	}
	for (const lang of missingLanguages) {
		const translation: Record<string, string> = {};
		await translateI18nJson(translation, lang, baseContent);
		const filename = baseFile.replace(filePattern, `$1${lang}$3`);
		await ensureDir(path.dirname(filename));
		await writeJson(filename, translation, {
			spaces: 4,
			EOL,
		});
		console.log(`Successfully created ${path.relative(".", filename)}`);
	}
}

async function translateI18nJson(
	content: Record<string, string>,
	lang: ioBroker.Languages,
	baseContent: Readonly<Record<string, string>>,
): Promise<void> {
	if (lang === "en") {
		return;
	}
	const time = new Date().getTime();
	for (const [t, base] of Object.entries(baseContent)) {
		if (!content[t]) {
			content[t] = await translateText(base, lang);
		}
	}
	console.log(
		gray(`Translate Admin en -> ${lang} ${new Date().getTime() - time} ms`),
	);
}

async function adminWords2languages(
	words: string,
	i18nBase: string,
): Promise<void> {
	const filePattern = createFilePattern(i18nBase);
	const data = parseWordJs(await readFile(words, "utf-8"));
	const langs = createEmptyLangObject(() => ({} as Record<string, string>));
	for (const [word, translations] of Object.entries(data)) {
		for (const [lang, translation] of Object.entries(translations)) {
			const language = lang as ioBroker.Languages;
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
		const language = lang as ioBroker.Languages;
		const keys = Object.keys(translations);
		keys.sort();
		const obj: Record<string, string> = {};
		for (const key of keys) {
			obj[key] = langs[language][key];
		}
		const filename = i18nBase.replace(filePattern, `$1${lang}$3`);
		await ensureDir(path.dirname(filename));
		await writeJson(filename, obj, {
			spaces: 4,
			EOL,
		});
		console.log(`Successfully updated ${path.relative(".", filename)}`);
	}
}

function parseWordJs(
	words: string,
): Record<string, Record<ioBroker.Languages, string>> {
	words = words.substring(words.indexOf("{"), words.length);
	words = words.substring(0, words.lastIndexOf(";"));

	const resultFunc = new Function("return " + words + ";");

	return resultFunc();
}

async function adminLanguages2words(i18nBase: string): Promise<void> {
	const filePattern = createFilePattern(i18nBase);
	const newWords: Record<string, Record<ioBroker.Languages, string>> = {};
	const files = await findAllLanguageFiles(i18nBase);
	for (const file of files) {
		const match = file.match(filePattern);
		if (!match) continue;
		const lang = match[2] as ioBroker.Languages;
		const translations = await readJson(file);
		for (const key of Object.keys(translations)) {
			newWords[key] = newWords[key] || createEmptyLangObject(() => "");
			newWords[key][lang] = translations[key];
		}
	}

	try {
		// merge existing and new words together (and check for missing translations)
		const existingWords = parseWordJs(await readFile(words, "utf-8"));
		for (const [key, translations] of Object.entries(existingWords)) {
			if (!newWords[key]) {
				console.warn(yellow(`Take from current words.js: ${key}`));
				newWords[key] = translations;
			}
			translateLanguages
				.filter((lang) => !newWords[key][lang])
				.forEach((lang) =>
					console.warn(yellow(`Missing "${lang}": ${key}`)),
				);
		}
	} catch (error) {
		// ignore error, we just use the strings from the translation files
		//console.log(error);
	}

	await writeFile(words, createWordsJs(newWords));
	console.log(`Successfully updated ${path.relative(".", words)}`);
}

function createWordsJs(
	data: Record<string, Record<ioBroker.Languages, string>>,
): string {
	const lines: string[] = [];
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
			const text = padRight(item.replace(/"/g, '\\"') + '",', 50);
			line += `"${lang}": "${text} `;
		}
		if (line) {
			line = line.trim();
			line = line.substring(0, line.length - 1);
		}
		const preamble = padRight(`"${word.replace(/"/g, '\\"')}": {`, 50);
		lines.push(`    ${preamble}${line}},`);
	}
	lines.push("};");
	return lines.join(EOL).trimEnd();
}
