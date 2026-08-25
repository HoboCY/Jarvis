using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Jarvis.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class Phase2RealtimeSessions : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "RealtimeSessions",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    ConversationId = table.Column<Guid>(type: "TEXT", nullable: false),
                    DeviceId = table.Column<Guid>(type: "TEXT", nullable: false),
                    ExternalSessionId = table.Column<string>(type: "TEXT", maxLength: 200, nullable: true),
                    Model = table.Column<string>(type: "TEXT", maxLength: 200, nullable: false),
                    Voice = table.Column<string>(type: "TEXT", maxLength: 100, nullable: false),
                    ContextVersion = table.Column<long>(type: "INTEGER", nullable: false),
                    Status = table.Column<int>(type: "INTEGER", nullable: false),
                    StartedAtMs = table.Column<long>(type: "INTEGER", nullable: false),
                    ConnectedAtMs = table.Column<long>(type: "INTEGER", nullable: true),
                    RotatedAtMs = table.Column<long>(type: "INTEGER", nullable: true),
                    DisconnectedAtMs = table.Column<long>(type: "INTEGER", nullable: true),
                    FailedAtMs = table.Column<long>(type: "INTEGER", nullable: true),
                    EndedAtMs = table.Column<long>(type: "INTEGER", nullable: true),
                    EndReason = table.Column<string>(type: "TEXT", maxLength: 500, nullable: true),
                    Version = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_RealtimeSessions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_RealtimeSessions_Conversations_ConversationId",
                        column: x => x.ConversationId,
                        principalTable: "Conversations",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_RealtimeSessions_Devices_DeviceId",
                        column: x => x.DeviceId,
                        principalTable: "Devices",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_RealtimeSessions_ConversationId_StartedAtMs",
                table: "RealtimeSessions",
                columns: new[] { "ConversationId", "StartedAtMs" });

            migrationBuilder.CreateIndex(
                name: "IX_RealtimeSessions_DeviceId",
                table: "RealtimeSessions",
                column: "DeviceId");

            migrationBuilder.CreateIndex(
                name: "IX_RealtimeSessions_ExternalSessionId",
                table: "RealtimeSessions",
                column: "ExternalSessionId",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "RealtimeSessions");
        }
    }
}
