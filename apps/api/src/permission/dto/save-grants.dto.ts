import { ArrayMaxSize, IsArray, IsInt, IsUUID, Min } from 'class-validator';

/**
 * 保存授权名单 —— **整表替换,不是增量**。
 *
 * 用整表替换的理由:名单通常只有几个人,前端本来就是拿着完整列表在编辑;
 * 拆成「加一个 / 删一个」两个接口会引入中间状态,而中间状态意味着
 * 两次请求之间名单是不完整的。
 */
export class SaveGrantsDto {
  /** 乐观锁。带错版本返回 409,由前端重新拉取。 */
  @IsInt()
  @Min(1)
  version!: number;

  /**
   * 授权名单(用户 id)。
   *
   * ⚠️ 这里**只做形状校验,不做业务校验** —— 组织范围的判定在
   * `PermissionService.replaceGrants` 里逐个做。前端传来的列表即使被篡改,
   * 也会在那一层被拒。
   */
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  userIds!: string[];
}
