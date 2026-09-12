import { Body, Controller, Header, HttpCode, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { User } from '@docmost/db/types/entity.types';
import { BaseService } from './base.service';
import {
  BaseCsvDto,
  BasePropertyDto,
  BaseRowDto,
  CreateBaseDto,
  DeletePropertyDto,
  DeleteRowDto,
  DeleteViewDto,
  BaseViewDto,
  UpdateBasePropertyDto,
  UpdateBaseRowDto,
} from './dto/base.dto';

@UseGuards(JwtAuthGuard)
@Controller('bases')
export class BaseController {
  constructor(private readonly bases: BaseService) {}
  @Post('info') @HttpCode(200) get(@Body('pageId') pageId: string, @AuthUser() user: User) { return this.bases.get(pageId, user); }
  @Post('create') @HttpCode(200) create(@Body() body: CreateBaseDto, @AuthUser() user: User) { return this.bases.create(body.parentPageId, user, body.template); }
  @Post('convert') @HttpCode(200) convert(@Body('pageId') pageId: string, @AuthUser() user: User) { return this.bases.convert(pageId, user); }
  @Post('properties/create') @HttpCode(200) addProperty(@Body() body: BasePropertyDto, @AuthUser() user: User) { return this.bases.addProperty(body.pageId, user, body, body.version); }
  @Post('properties/update') @HttpCode(200) updateProperty(@Body() body: UpdateBasePropertyDto, @AuthUser() user: User) { return this.bases.updateProperty(body.pageId, body.propertyId, user, body, body.version); }
  @Post('properties/delete') @HttpCode(200) deleteProperty(@Body() body: DeletePropertyDto, @AuthUser() user: User) { return this.bases.removeProperty(body.pageId, body.propertyId, user, body.version); }
  @Post('rows/create') @HttpCode(200) addRow(@Body() body: BaseRowDto, @AuthUser() user: User) { return this.bases.addRow(body.pageId, user, body.cells, body.version); }
  @Post('rows/update') @HttpCode(200) updateRow(@Body() body: UpdateBaseRowDto, @AuthUser() user: User) { return this.bases.updateRow(body.pageId, body.rowId, user, body); }
  @Post('rows/delete') @HttpCode(200) deleteRow(@Body() body: DeleteRowDto, @AuthUser() user: User) { return this.bases.removeRow(body.pageId, body.rowId, user, body.version); }
  @Post('views/save') @HttpCode(200) saveView(@Body() body: BaseViewDto, @AuthUser() user: User) { return this.bases.saveView(body.pageId, user, body, body.version); }
  @Post('views/delete') @HttpCode(200) deleteView(@Body() body: DeleteViewDto, @AuthUser() user: User) { return this.bases.removeView(body.pageId, body.viewId, user, body.version); }
  @Post('import-csv') @HttpCode(200) importCsv(@Body() body: BaseCsvDto, @AuthUser() user: User) { return this.bases.importCsv(body.pageId, user, body.csv, body.version); }
  @Post('export-csv') @HttpCode(200) @Header('content-type', 'text/csv; charset=utf-8') exportCsv(@Body('pageId') pageId: string, @AuthUser() user: User) { return this.bases.exportCsv(pageId, user); }
}
