import { AVATAR_COLORS } from '@knowledgecool/shared';
import { IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';

/**
 * 新建空间请求体(DESIGN.md §6.2 `POST /spaces`)。
 *
 * 只有 `name` 必填。slug / letter / color 都可由服务端按名称推导 ——
 * 让管理员建空间时只需要打一个名字。
 */
export class CreateSpaceDto {
  @IsString()
  @Length(1, 64, { message: '空间名称长度需在 1~64 个字符之间' })
  name!: string;

  /**
   * 地址友好的短标识。省略时服务端由 name 转写并保证唯一。
   * 显式提供时严格校验:它是会被放进 URL 的东西,不能带任意字符。
   */
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{1,47}$/, {
    message: 'slug 只能用小写字母、数字与连字符,长度 2~48,且需以字母或数字开头',
  })
  slug?: string;

  /** 侧边栏展示用的标识字。省略时取名称首字。 */
  @IsOptional()
  @IsString()
  @Length(1, 4, { message: '标识字长度需在 1~4 个字符之间' })
  letter?: string;

  /**
   * 白名单校验而不是任意字符串 —— 这个值最终会进前端的样式类名,
   * 自由字符串等于开了个注入口子(见 shared 的 AVATAR_COLORS 注释)。
   */
  @IsOptional()
  @IsIn([...AVATAR_COLORS], { message: '颜色不在允许范围内' })
  color?: (typeof AVATAR_COLORS)[number];
}
