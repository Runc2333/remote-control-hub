export default {
  "*.{js,mjs,cjs,ts,tsx}": "eslint --fix --max-warnings=0",
  "*.{json,yaml,yml,css,md}": "prettier --write",
  "agent/**/*.rs": () => [
    "cargo fmt --manifest-path agent/Cargo.toml --all -- --check",
    "cargo clippy --manifest-path agent/Cargo.toml --workspace --all-targets --locked -- -D warnings",
  ],
};
