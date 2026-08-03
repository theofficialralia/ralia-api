import { ApiProperty } from '@nestjs/swagger';

export class NotificationDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'offer.created' })
  type!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  body!: string;

  @ApiProperty({ nullable: true, type: 'object', additionalProperties: true, description: 'Structured payload (ids, amounts) for deep-linking.' })
  data!: Record<string, unknown> | null;

  @ApiProperty()
  read!: boolean;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;
}

export class NotificationListDto {
  @ApiProperty({ type: [NotificationDto] })
  items!: NotificationDto[];

  @ApiProperty({ description: 'How many are still unread.' })
  unread!: number;
}
