import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['dist/', 'node_modules/', 'src/words.ts'] },
    js.configs.recommended,
    ...tseslint.configs.strict,
    { files: ['src/**/*.tsx'], ...reactHooks.configs.flat['recommended-latest'] },
    {
        rules: {
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
        },
    },
    {
        files: ['scripts/**/*.mjs'],
        languageOptions: { globals: { console: 'readonly', process: 'readonly', URL: 'readonly' } },
    },
);
