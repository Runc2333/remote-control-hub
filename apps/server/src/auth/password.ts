import { argon2id, hash, verify } from "argon2";

const ARGON2_OPTIONS = {
  hashLength: 32,
  memoryCost: 65_536,
  parallelism: 1,
  timeCost: 3,
  type: argon2id,
} as const;

export const hashPassword = (password: string): Promise<string> => {
  if (password.length < 12 || password.length > 256) {
    throw new Error("password_length_invalid");
  }
  return hash(password, ARGON2_OPTIONS);
};

export const verifyPassword = async (
  digest: string,
  password: string,
): Promise<boolean> => {
  try {
    return await verify(digest, password);
  } catch {
    return false;
  }
};
