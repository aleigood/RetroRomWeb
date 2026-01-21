module.exports = {
    env: {
        commonjs: true,
        es2021: true,
        node: true
    },
    extends: 'standard',
    overrides: [],
    parserOptions: {
        ecmaVersion: 'latest'
    },
    rules: {
        // 允许使用 console，因为是后端服务和脚本，需要输出日志
        'no-console': 'off',
        // 强制使用分号，避免一些自动插入分号带来的潜在逻辑错误
        semi: ['error', 'always'],
        // 缩进使用 4 个空格，使代码层级更清晰
        indent: ['error', 4],
        // 允许为了对齐而在对象属性中增加空格
        'key-spacing': ['error', { mode: 'minimum' }]
    }
};
