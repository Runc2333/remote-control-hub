export function getAdministratorValidationError(
  identifier: string,
  password: string,
  passwordConfirmation: string,
): string | undefined {
  if (identifier.trim().length < 3) {
    return "请输入有效的管理员登录标识。";
  }
  if (password.length < 12) {
    return "管理员密码至少需要 12 个字符。";
  }
  if (password !== passwordConfirmation) {
    return "两次输入的管理员密码不一致。";
  }
  return undefined;
}
