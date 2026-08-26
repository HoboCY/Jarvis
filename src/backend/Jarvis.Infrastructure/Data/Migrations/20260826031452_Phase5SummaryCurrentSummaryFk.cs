using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Jarvis.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class Phase5SummaryCurrentSummaryFk : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateIndex(
                name: "IX_Conversations_CurrentSummaryId",
                table: "Conversations",
                column: "CurrentSummaryId");

            migrationBuilder.AddForeignKey(
                name: "FK_Conversations_ConversationSummaries_CurrentSummaryId",
                table: "Conversations",
                column: "CurrentSummaryId",
                principalTable: "ConversationSummaries",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_Conversations_ConversationSummaries_CurrentSummaryId",
                table: "Conversations");

            migrationBuilder.DropIndex(
                name: "IX_Conversations_CurrentSummaryId",
                table: "Conversations");
        }
    }
}
