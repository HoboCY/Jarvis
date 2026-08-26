using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Jarvis.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class Phase5SummariesMemory : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "ConversationSummaries",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    ConversationId = table.Column<Guid>(type: "TEXT", nullable: false),
                    FromSequence = table.Column<long>(type: "INTEGER", nullable: false),
                    ToSequence = table.Column<long>(type: "INTEGER", nullable: false),
                    Summary = table.Column<string>(type: "TEXT", maxLength: 200000, nullable: false),
                    Model = table.Column<string>(type: "TEXT", maxLength: 200, nullable: false),
                    CreatedAtMs = table.Column<long>(type: "INTEGER", nullable: false),
                    Version = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ConversationSummaries", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ConversationSummaries_Conversations_ConversationId",
                        column: x => x.ConversationId,
                        principalTable: "Conversations",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "MemoryFacts",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    UserId = table.Column<Guid>(type: "TEXT", nullable: false),
                    Key = table.Column<string>(type: "TEXT", maxLength: 200, nullable: false),
                    ValueJson = table.Column<string>(type: "TEXT", maxLength: 100000, nullable: false),
                    SourceMessageId = table.Column<Guid>(type: "TEXT", nullable: true),
                    Confidence = table.Column<double>(type: "REAL", nullable: false),
                    Sensitive = table.Column<bool>(type: "INTEGER", nullable: false),
                    Status = table.Column<int>(type: "INTEGER", nullable: false),
                    SupersedesMemoryId = table.Column<Guid>(type: "TEXT", nullable: true),
                    LastConfirmedAtMs = table.Column<long>(type: "INTEGER", nullable: true),
                    CreatedAtMs = table.Column<long>(type: "INTEGER", nullable: false),
                    UpdatedAtMs = table.Column<long>(type: "INTEGER", nullable: false),
                    Version = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MemoryFacts", x => x.Id);
                    table.ForeignKey(
                        name: "FK_MemoryFacts_MemoryFacts_SupersedesMemoryId",
                        column: x => x.SupersedesMemoryId,
                        principalTable: "MemoryFacts",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_MemoryFacts_Messages_SourceMessageId",
                        column: x => x.SourceMessageId,
                        principalTable: "Messages",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_MemoryFacts_Users_UserId",
                        column: x => x.UserId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ConversationSummaries_ConversationId_ToSequence",
                table: "ConversationSummaries",
                columns: new[] { "ConversationId", "ToSequence" });

            migrationBuilder.CreateIndex(
                name: "IX_MemoryFacts_SourceMessageId",
                table: "MemoryFacts",
                column: "SourceMessageId");

            migrationBuilder.CreateIndex(
                name: "IX_MemoryFacts_SupersedesMemoryId",
                table: "MemoryFacts",
                column: "SupersedesMemoryId");

            migrationBuilder.CreateIndex(
                name: "IX_MemoryFacts_UserId_Key",
                table: "MemoryFacts",
                columns: new[] { "UserId", "Key" },
                unique: true,
                filter: "Status = 0");

            migrationBuilder.CreateIndex(
                name: "IX_MemoryFacts_UserId_Status_UpdatedAtMs",
                table: "MemoryFacts",
                columns: new[] { "UserId", "Status", "UpdatedAtMs" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ConversationSummaries");

            migrationBuilder.DropTable(
                name: "MemoryFacts");
        }
    }
}
