using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Jarvis.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class Phase7MobilePairingSessions : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "MobilePairings",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    UserId = table.Column<Guid>(type: "TEXT", nullable: false),
                    CodeHash = table.Column<string>(type: "TEXT", maxLength: 128, nullable: false),
                    DeviceName = table.Column<string>(type: "TEXT", maxLength: 200, nullable: false),
                    Platform = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                    CapabilitiesJson = table.Column<string>(type: "TEXT", maxLength: 20000, nullable: false),
                    CreatedAtMs = table.Column<long>(type: "INTEGER", nullable: false),
                    ExpiresAtMs = table.Column<long>(type: "INTEGER", nullable: false),
                    ConsumedAtMs = table.Column<long>(type: "INTEGER", nullable: true),
                    Version = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MobilePairings", x => x.Id);
                    table.ForeignKey(
                        name: "FK_MobilePairings_Users_UserId",
                        column: x => x.UserId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "MobileSessions",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    UserId = table.Column<Guid>(type: "TEXT", nullable: false),
                    DeviceId = table.Column<Guid>(type: "TEXT", nullable: false),
                    RefreshTokenHash = table.Column<string>(type: "TEXT", maxLength: 128, nullable: false),
                    CreatedAtMs = table.Column<long>(type: "INTEGER", nullable: false),
                    LastRefreshedAtMs = table.Column<long>(type: "INTEGER", nullable: false),
                    RefreshTokenExpiresAtMs = table.Column<long>(type: "INTEGER", nullable: false),
                    RevokedAtMs = table.Column<long>(type: "INTEGER", nullable: true),
                    Version = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MobileSessions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_MobileSessions_Devices_DeviceId",
                        column: x => x.DeviceId,
                        principalTable: "Devices",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_MobileSessions_Users_UserId",
                        column: x => x.UserId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_MobilePairings_CodeHash",
                table: "MobilePairings",
                column: "CodeHash",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_MobilePairings_UserId_ExpiresAtMs_ConsumedAtMs",
                table: "MobilePairings",
                columns: new[] { "UserId", "ExpiresAtMs", "ConsumedAtMs" });

            migrationBuilder.CreateIndex(
                name: "IX_MobileSessions_DeviceId",
                table: "MobileSessions",
                column: "DeviceId");

            migrationBuilder.CreateIndex(
                name: "IX_MobileSessions_RefreshTokenHash",
                table: "MobileSessions",
                column: "RefreshTokenHash",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_MobileSessions_UserId_DeviceId_RevokedAtMs",
                table: "MobileSessions",
                columns: new[] { "UserId", "DeviceId", "RevokedAtMs" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "MobilePairings");

            migrationBuilder.DropTable(
                name: "MobileSessions");
        }
    }
}
