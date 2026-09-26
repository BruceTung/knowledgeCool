import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';

/**
 * 限制字符串的 **UTF-8 字节数**(不是字符数)。
 *
 * 为什么需要它:`@MaxLength` 数的是 UTF-16 码元,而 bcrypt 的 72 字节上限
 * 是按**字节**算的。一个汉字 3 字节,所以「最多 24 个汉字」就撞到上限了 ——
 * 用 MaxLength(72) 会放过 72 个汉字(216 字节),然后被 bcrypt 静默截断。
 *
 * 这类"看起来限制了、其实没限制住"的校验比不校验更危险,因为它会让人以为已经安全了。
 */
export function MaxUtf8Bytes(maxBytes: number, options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'maxUtf8Bytes',
      target: object.constructor,
      propertyName,
      constraints: [maxBytes],
      options,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          if (typeof value !== 'string') return false;
          const [limit] = args.constraints as [number];
          return Buffer.byteLength(value, 'utf8') <= limit;
        },
        defaultMessage(args: ValidationArguments): string {
          const [limit] = args.constraints as [number];
          return `${args.property} 超过 ${limit} 字节上限`;
        },
      },
    });
  };
}
