import importX from "eslint-plugin-import-x";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{ ignores: ["dist/**", "node_modules/**", "**/*.d.ts"] },
	{
		files: ["src/**/*.ts", "test/**/*.ts"],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		plugins: {
			"@typescript-eslint": tseslint.plugin,
			"import-x": importX,
		},
		settings: {
			"import-x/resolver": { typescript: true },
		},
		rules: {
			"@typescript-eslint/no-floating-promises": "error",
			"import-x/no-cycle": ["error", { ignoreExternal: true }],
		},
	},
);
