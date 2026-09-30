# Contributing

Thanks for helping. Issues and pull requests are welcome.

- **Open an issue first** for anything larger than a small fix, so we can
  agree on the approach before you build it.
- **One change per pull request**, with what changed, why, and how you tested
  it (the commands you ran and their output).
- **Tests:** a fix comes with a test that fails without it. Run the checks
  from the README before you push. Rust changes must pass
  `cargo clippy --locked --workspace --all-targets --all-features --manifest-path src-tauri/Cargo.toml -- -D warnings`.
- **Privacy is the product.** Nothing from the computer graph leaves the
  machine. A change that sends local data anywhere will not be accepted.

By contributing you agree that your contributions are licensed under the
[Apache-2.0](LICENSE) licence.
