import { IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";

export class CreateBusinessDto {
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name: string;

  @IsString()
  @Matches(/^(RETAILER|WHOLESALER|PRODUCER|MARKETER)$/)
  role: string;

  @IsString()
  @MinLength(2)
  @MaxLength(30)
  city: string;

  @IsOptional()
  @IsString()
  @MaxLength(14)
  phone?: string;
}

export class EditBusinessDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsString()
  @Matches(/^(RETAILER|WHOLESALER|PRODUCER|MARKETER)$/)
  role?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(30)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(14)
  phone?: string;
}
