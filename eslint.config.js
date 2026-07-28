const js = require('@eslint/js');
const prettier = require('eslint-config-prettier/flat');
const globals = require('globals');
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'eslint.config.js'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  // 포매팅은 prettier(`pnpm format`) 소관이다 — 겹치는 규칙을 꺼서 둘이 싸우지 않게 한다.
  prettier,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    rules: {
      // DTO·엔티티 필드는 `field!: string`으로 선언하고 값은 런타임에 채운다.
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // NestJS 데코레이터가 붙은 빈 생성자·인터페이스 구현에서 흔히 걸린다.
      '@typescript-eslint/no-empty-function': ['error', { allow: ['constructors'] }],
      'no-console': 'error',
    },
  },
);
