import * as monaco from "monaco-editor";
import * as wasm from "erg-playground";
import {
	compressToEncodedURIComponent,
	decompressFromEncodedURIComponent,
} from "lz-string";

import "./index.css";
import { erg_syntax_def } from "./syntax";
import { escape_ansi } from "./escape";
import { validate } from "./check";
import { suggest } from "./complete";
import { ConfigModal, set_dark, set_light } from "./config";
import { FileTree } from "./file_tree";
import { replace_import } from "./importer";

let playground = wasm.Playground.new();

const erg_completion_provider = {
	provideCompletionItems: function (
		model: monaco.editor.ITextModel,
		position: monaco.IPosition,
	) {
		return suggest(playground, model, position);
	},
};

const WAIT_FOR = 50;

export function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function get_init_code() {
	let value = 'print! "Hello, world!"';
	// load code from local storage (if exists)
	let cached = localStorage.getItem("playground.er");
	if (cached !== null && cached.length !== 0) {
		value = cached;
	}
	// load code from URL (if specified)
	let query = window.location.search.slice(1); // ?code=
	query.split("&").forEach(function (part) {
		const item = part.split("=");
		if (item[0] === "code") {
			const _value = decompressFromEncodedURIComponent(item.slice(1).join("="));
			if (_value !== null) {
				value = _value;
			}
		}
	});
	return value;
}

monaco.languages.register({ id: "erg" });
monaco.languages.setMonarchTokensProvider("erg", erg_syntax_def);
monaco.languages.registerCompletionItemProvider("erg", erg_completion_provider);

// @ts-ignore
self.MonacoEnvironment = {
	getWorkerUrl: function (moduleId: string, label: string) {
		if (label === "typescript" || label === "javascript") {
			return "./ts.worker.bundle.js";
		}
		return "./editor.worker.bundle.js";
	},
};

class PyCodeArea {
	display: monaco.editor.IStandaloneCodeEditor;
	area: HTMLElement;
	close_btn: HTMLButtonElement;

	constructor(code_area: HTMLDivElement) {
		this.area = document.createElement("div");
		this.area.id = "py-code-area";
		this.area.className = "notification";
		this.area.hidden = true;
		code_area.appendChild(this.area);
		let py_code_message = document.createElement("div");
		py_code_message.className = "message-header";
		py_code_message.innerHTML = "Transpiled Python code";
		this.area.appendChild(py_code_message);
		const py_uri = monaco.Uri.parse("inmemory://playground.py");
		const py_model = monaco.editor.createModel("", "erg", py_uri);
		let py_code_editor = document.createElement("div");
		py_code_editor.id = "py-code-editor";
		py_code_editor.className = "block";
		this.area.appendChild(py_code_editor);
		this.display = monaco.editor.create(
			document.getElementById("py-code-editor")!,
			{
				language: "erg",
				theme: "vs",
				model: py_model,
				readOnly: true,
				scrollbar: {
					handleMouseWheel: false,
				},
			},
		);
		this.close_btn = document.createElement("button");
		this.close_btn.className = "delete";
		this.area.appendChild(this.close_btn);
	}
}

class OutputArea {
	output: HTMLDivElement;

	clear(this: this) {
		this.output.innerHTML = "";
	}
	dump(this: this, data: string) {
		this.output.innerHTML += escape_ansi(data);
	}
	select(this: this) {
		this.output.focus();
		window.getSelection()?.selectAllChildren(this.output);
	}

	constructor() {
		const output_area = document.createElement("div");
		output_area.className = "block container is-fluid";
		document.body.appendChild(output_area);
		this.output = document.createElement("div");
		this.output.id = "result";
		this.output.className = "box content textarea block";
		let _this = this;
		this.output.onclick = function (_event) {
			_this.select();
		};
		output_area.appendChild(this.output);
	}
}

export class Playground {
	file_tree!: FileTree;
	editor!: monaco.editor.IStandaloneCodeEditor;
	on_did_change_listener!: monaco.IDisposable;
	py_code_area!: PyCodeArea;
	output!: OutputArea;
	run_btn!: HTMLButtonElement;
	transpile_btn!: HTMLButtonElement;
	share_btn!: HTMLButtonElement;
	config_modal!: ConfigModal;

	render_py_code(this: this, code: string) {
		this.py_code_area.area.hidden = false;
		this.py_code_area.display.setValue(code);
		this.py_code_area.display.layout();
	}
	handle_result(this: this, result: string, code: string) {
		if (result.startsWith("<<CompileError>>")) {
			result = result.replace("<<CompileError>>", "");
			const replacer = function (match: string, p1: string) {
				let lineno = parseInt(p1);
				let lines = code.split("\n");
				return `${lineno} | ${lines.slice(lineno - 1, lineno)}`;
			};
			result = result.replace(/([0-9]+) \| /g, replacer);
			this.output.dump(result);
		} else if (result.startsWith("<<RuntimeError>>")) {
			result = result.replace("<<RuntimeError>>", "");
			this.output.dump("runtime error caused:\n");
			this.output.dump(result);
		} else if (result.length > 0) {
			this.output.dump(result);
		}
	}
	close_py_code_area(this: this, _event: Event) {
		this.py_code_area.area.hidden = true;
	}

	async run(this: this, _event: Event) {
		this.run_btn.classList.add("is-loading");
		await sleep(WAIT_FOR);
		this.output.clear();
		playground = wasm.Playground.new();
		let code = this.editor.getValue();
		let replaced_code = replace_import(code);
		let _this = this;
		playground.set_stdout(function (data: string) {
			_this.output.dump(data);
		});
		let result = playground.exec(replaced_code);
		this.handle_result(result, code);
		localStorage.setItem(this.file_tree.current_file, code);
		this.run_btn.classList.remove("is-loading");
	}

	async transpile(this: this, _event: Event) {
		this.transpile_btn.classList.add("is-loading");
		await sleep(WAIT_FOR);
		this.output.clear();
		playground = wasm.Playground.new();
		let code = this.editor.getValue();
		let replaced_code = replace_import(code);
		let _this = this;
		playground.set_stdout(function (data: string) {
			_this.output.dump(data);
		});
		let opt_code = playground.transpile(replaced_code);
		if (opt_code != null) {
			this.render_py_code(opt_code);
			localStorage.setItem(this.file_tree.current_file, code);
		} else {
			this.output.dump("transpilation failed");
		}
		this.transpile_btn.classList.remove("is-loading");
	}

	async share_url(this: this, _event: Event) {
		this.share_btn.classList.add("is-loading");
		// await sleep(WAIT_FOR);
		let code = this.editor.getValue();
		let compressed = compressToEncodedURIComponent(code);
		let url = `https://erg-lang.org/web-ide/?code=${compressed}`;
		this.output.clear();
		this.output.dump(url);
		localStorage.setItem(this.file_tree.current_file, code);
		this.share_btn.classList.remove("is-loading");
		this.output.select();
	}

	init_header(this: this) {
		const hero = document.createElement("section");
		hero.id = "hero";
		hero.className = "hero block is-info is-small";
		document.body.appendChild(hero);
		const hero_body = document.createElement("div");
		hero_body.className = "hero-body";
		hero.appendChild(hero_body);
		let logo = document.createElement("div");
		logo.className = "container columns";
		hero_body.appendChild(logo);
		const logo_img = document.createElement("img");
		logo_img.src = "data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz48c3ZnIGlkPSJf44Kk44Ok44O8XzEiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgdmlld0JveD0iMCAwIDk0NS4zNiA4MDguNTEiPjxkZWZzPjxzdHlsZT4uY2xzLTF7ZmlsbDojMWMxZDFkO308L3N0eWxlPjwvZGVmcz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik05MjcuODQsLjFoLTIwOS40OXYtLjAzYy0xNTQuNTMsLjM5LTM0NS40Ny0uMjgtNDk4LjY4LDAtMTMuNjQsMC0yNS42MSwxMC4xNC0yOS4yNywyNC44Mkw5OC42MywzOTEuOGwtNi4yMiwyNC44NkwuNjYsNzgzLjU0Yy0zLjEyLDEyLjQ5LDUuMjgsMjQuODYsMTYuODksMjQuODYsNDEuMiwuMzQsMTI4LjgyLS4yNCwxNzAuNTEsMHYuMDNjMTYwLjg4LS4xNywzNzguMzksLjEyLDUzNy42MSwwLDEzLjY0LDAsMjUuNjEtMTAuMTUsMjkuMjgtMjQuODIsNDcuMTgtMTg5LjAxLDE0Mi42OC01NzAuMiwxODkuNzUtNzU4LjY5aDBjMy4xMi0xMi40Ny01LjI3LTI0LjgyLTE2Ljg2LTI0LjgyWk0yODcuMzUsMjQuODloNjUuMjN2LjAzaDI3My4zN2wtOTEuNzcsMzY2LjkyaC0xMTUuMDZ2LS4wM0gxOTUuNThMMjg3LjM1LDI0Ljg5Wm0tOTcuOTksMzkxLjc4aDEyNi41NGwtOTEuNzUsMzY2Ljg3SDk3LjYxbDkxLjc1LTM2Ni44N1ptNDY4LjY2LDM2Ni45aC0yMjEuODF2LjAyaC0xMTUuMDZzOTEuNzYtMzY2Ljg4LDkxLjc2LTM2Ni44OWgzMzYuODdsLTkxLjc1LDM2Ni44N1ptOTcuOTctMzkxLjczaC0xMjQuODZMNzIyLjksMjQuOTJoMTI0Ljg2bC05MS43NywzNjYuOTJaIi8+PHJlY3QgY2xhc3M9ImNscy0xIiB4PSIxNDAuNDUiIHk9IjM2MC40NSIgd2lkdGg9IjY2NC40NiIgaGVpZ2h0PSI4Ny42Ii8+PHJlY3QgY2xhc3M9ImNscy0xIiB4PSIyMjIuMzgiIHk9Ii4wNyIgd2lkdGg9IjY2NC40NiIgaGVpZ2h0PSI4Ny42Ii8+PHJlY3QgY2xhc3M9ImNscy0xIiB4PSI2Mi43OSIgeT0iNzIwLjgzIiB3aWR0aD0iNjY0LjQ2IiBoZWlnaHQ9Ijg3LjYiLz48L3N2Zz4=";
		logo_img.alt = "erg logo";
		logo_img.className = "column is-narrow logo";
		logo_img.id = "erg-logo";
		logo.appendChild(logo_img);
		const title = document.createElement("p");
		title.className = "title column";
		title.innerHTML = "Erg Playground";
		logo.appendChild(title);
		const note = document.createElement("div");
		note.className = "notification is-small has-text-grey-dark";
		note.innerHTML =
			'Web-REPL is here: <a href="https://erg-lang.org/web-repl/">https://erg-lang.org/web-repl</a>';
		hero_body.appendChild(note);
		const close_btn = document.createElement("button");
		close_btn.className = "delete";
		close_btn.onclick = function (_event) {
			hero_body.removeChild(note);
		};
		note.appendChild(close_btn);
	}

	init_main_area(this: this) {
		const main_area = document.createElement("div");
		main_area.className = "block columns container";
		main_area.id = "main-area";
		document.body.appendChild(main_area);
		this.init_file_tree(main_area);
		this.init_editor_area(main_area);
	}

	init_file_tree(this: this, main_area: HTMLElement) {
		this.file_tree = new FileTree(this);
		main_area.appendChild(this.file_tree.tree_area);
	}

	init_editor_area(this: this, main_area: HTMLDivElement) {
		const code_area = document.createElement("div");
		code_area.className = "column";
		main_area.appendChild(code_area);

		const editor_area = document.createElement("div");
		editor_area.id = "editor";
		editor_area.className = "block";
		code_area.appendChild(editor_area);

		this.py_code_area = new PyCodeArea(code_area);

		let init_code = get_init_code();
		const uri = monaco.Uri.parse("inmemory://playground.er");
		const model = monaco.editor.createModel(init_code, "erg", uri);
		this.editor = monaco.editor.create(document.getElementById("editor")!, {
			language: "erg",
			theme: "vs",
			model: model,
			scrollbar: {
				handleMouseWheel: false,
			},
		});
		this.on_did_change_listener = model.onDidChangeContent(() => {
			validate(model);
		});
		validate(model);
	}

	init_palette(this: this) {
		let palette_area = document.createElement("div");
		palette_area.className = "container block is-fluid";
		document.body.appendChild(palette_area);
		const palette = document.createElement("div");
		palette.className = "buttons block";
		palette_area.appendChild(palette);

		this.run_btn = document.createElement("button");
		this.run_btn.id = "run-button";
		this.run_btn.className = "button is-primary is-medium";
		this.run_btn.innerHTML = "Run";
		palette.appendChild(this.run_btn);

		this.transpile_btn = document.createElement("button");
		this.transpile_btn.id = "transpile-button";
		this.transpile_btn.className = "button is-warning is-light";
		this.transpile_btn.innerHTML = "Transpile";
		palette.appendChild(this.transpile_btn);

		this.share_btn = document.createElement("button");
		this.share_btn.id = "share-button";
		this.share_btn.className = "button is-link is-light";
		this.share_btn.innerHTML = "Share";
		palette.appendChild(this.share_btn);

		this.config_modal = new ConfigModal(this, palette);
	}

	init_output() {
		this.output = new OutputArea();
	}

	constructor() {
		this.init_header();
		this.init_main_area();
		this.init_palette();
		this.init_output();

		const footer = document.createElement("div");
		footer.className = "box";
		footer.id = "foot";
		document.body.appendChild(footer);

		if (localStorage.getItem(".config:color-theme") === "dark") {
			set_dark(this);
		} else {
			set_light(this);
		}

		let _this = this;
		this.run_btn.addEventListener("click", function (_event) {
			_this.run(_event);
		});
		this.transpile_btn.addEventListener("click", function (_event) {
			_this.transpile(_event);
		});
		this.share_btn.addEventListener("click", function (_event) {
			_this.share_url(_event);
		});
		this.py_code_area.close_btn.onclick = function (_event) {
			_this.close_py_code_area(_event);
		};
	}
}

(window as any).playground = new Playground();
